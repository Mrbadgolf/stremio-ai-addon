// index.js
import { addonBuilder } from 'stremio-addon-sdk';
import express from 'express';
import cors from 'cors';
import LRU from 'lru-cache';
import { fetch } from 'undici';
import pino from 'pino';
import { z } from 'zod';

/* ---------- env ---------- */
const Env = z.object({
  TRAKT_CLIENT_ID: z.string().optional(), // recommended for Trakt API quota
  RD_API_KEY: z.string().optional(),      // your Real-Debrid API key
  PORT: z.string().optional()
}).parse(process.env);

const log = pino({ level: 'info' });

/* ---------- manifest ---------- */
const MANIFEST = {
  id: 'com.mrbadgolf.stremio-ai-rd',
  version: '1.3.0',
  name: 'AI + RD (IMDb + Trakt)',
  description: 'Dynamic AI catalogs (Trakt) + Cinemeta meta + Real-Debrid streams',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'], // we operate purely on IMDb IDs
  catalogs: [
    { type: 'movie',  id: 'ai-movies', name: 'AI Picks (Movies)' },
    { type: 'series', id: 'ai-series', name: 'AI Picks (Series)' },
    { type: 'movie',  id: 'trending',  name: 'Trending' },
    { type: 'movie',  id: 'quality',   name: 'Quality Selections' }
  ]
};

const cache = new LRU({ max: 1000, ttl: 1000 * 60 * 60 * 6 }); // 6h
const builder = new addonBuilder(MANIFEST);

/* ---------- Stremio handlers ---------- */
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const key = `catalog:${type}:${id}:${JSON.stringify(extra||{})}`;
  const hit = cache.get(key); if (hit) return { metas: hit };

  // personalize (if events present) by reusing the same feed logic
  const userId = (extra && extra.userId) || 'anon';
  const rows = await buildRows({ userId });
  const row = pickRowForCatalog(id, rows, type);
  const metas = (row?.items || []).map(toStremioMeta).slice(0, 50);

  cache.set(key, metas);
  return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
  // Get metadata from Stremio Cinemeta by IMDb id (no TMDB)
  const key = `meta:${type}:${id}`;
  const hit = cache.get(key); if (hit) return { meta: hit };
  const meta = await fetchCinemetaMeta(type, id);
  cache.set(key, meta);
  return { meta };
});

builder.defineStreamHandler(async ({ type, id }) => {
  // Real-Debrid: return streams for an IMDb id
  const streams = await streamsFromRealDebrid(id, type);
  return { streams };
});

/* ---------- Express: only API + addon endpoints ---------- */
const app = express();
app.use(cors());
app.use(express.json());

// health
app.get('/health', (_, res) => res.json({ ok: true }));

// events (learning loop): user → [{ imdb, type, progress, ts, tags }]
const userEvents = new Map();

app.post('/api/events', (req, res) => {
  const { userId, imdb, type, progress = 0, ts = Date.now(), tags = [] } = req.body || {};
  if (!userId || !imdb || !type) return res.status(400).json({ error: 'userId, imdb, type required' });
  const arr = userEvents.get(userId) || [];
  arr.push({ imdb, type, progress, ts, tags });
  userEvents.set(userId, arr);
  res.json({ ok: true });
});

app.get('/api/feed', async (req, res) => {
  const userId = String(req.query.userId || 'anon');
  const events = userEvents.get(userId) || [];
  const userVec = buildUserVec(events);
  const rows = await buildRows({ userId });      // Trakt-backed candidates
  const personalized = rows.map(r => ({ ...r, items: rerank(r.items, userVec).slice(0, 20) }));
  res.json({ rows: personalized });
});

// mount Stremio endpoints
const stremioInterface = builder.getInterface();
app.get('/manifest.json', stremioInterface);
app.get('/catalog/:type/:id.json', stremioInterface);
app.get('/meta/:type/:id.json', stremioInterface);
app.get('/stream/:type/:id.json', stremioInterface);

// boot
const port = Number(Env.PORT || 8080);
app.listen(port, () => log.info({ port }, 'service up'));

/* ---------- personalization helpers ---------- */
function pickRowForCatalog(catalogId, rows) {
  if (catalogId === 'trending')  return rows.find(r => r.id === 'trending');
  if (catalogId === 'quality')   return rows.find(r => r.id === 'quality');
  if (catalogId === 'ai-movies') return rows.find(r => r.id === 'ai-movies');
  if (catalogId === 'ai-series') return rows.find(r => r.id === 'ai-series');
  return rows[0];
}

function toStremioMeta(it) {
  return {
    id: it.id,
    type: it.type || 'movie',
    name: it.title,
    poster: it.poster,
    description: it.description || '',
    genres: it.genres || [],
    year: it.year
  };
}

function buildUserVec(events) {
  const weights = { complete: 3, like: 2.5, start: 1.0, abandon: -0.5 };
  const vec = {};
  for (const e of events) {
    const w = (weights[e.type] || 0.5) * (1 + (e.progress || 0));
    for (const t of (e.tags || [])) {
      const k = t.toLowerCase(); vec[k] = (vec[k] || 0) + w;
    }
  }
  return vec;
}
function tagsToVec(tags) { const v = {}; for (const t of tags || []) v[t.toLowerCase()] = 1; return v; }
function cosine(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot=0, na=0, nb=0;
  for (const k of keys){ const va=a[k]||0, vb=b[k]||0; dot+=va*vb; na+=va*va; nb+=vb*vb; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function rerank(items, userVec) {
  const scored = (items||[]).map(it => {
    const sim = cosine(userVec, tagsToVec(it.genres||[])) || 0;
    const rating = it.rating || 0;
    const recency = it.year ? (1 + (it.year - 2015) * 0.03) : 1;
    return { it, score: rating*0.7 + sim*2.5 + recency*0.3 };
  }).sort((a,b)=>b.score-a.score).map(x=>x.it);
  return scored;
}

/* ---------- data sources (NO TMDB) ---------- */

/** Cinemeta: Stremio metadata by IMDb id (no key needed) */
async function fetchCinemetaMeta(type, imdbId) {
  // type: 'movie' | 'series'
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'stremio-addon' } });
  if (!r.ok) throw new Error(`Cinemeta ${r.status}`);
  const { meta } = await r.json();
  // Normalize fields for Stremio response
  return {
    id: imdbId,
    type,
    name: meta?.name || meta?.title || meta?.originalName || 'Unknown',
    description: meta?.description || meta?.overview || '',
    poster: (meta?.poster || meta?.background) || '',
    genres: meta?.genres || [],
    year: meta?.releaseInfo ? Number(String(meta.releaseInfo).slice(0,4)) : (meta?.year || undefined)
  };
}

/** Trakt: pull candidates (trending/anticipated/popular) with IMDb IDs */
async function traktList({ type='movies', path='trending', limit=30 }) {
  // type: 'movies' | 'shows'; path examples: trending, popular, anticipated, played
  const url = `https://api.trakt.tv/${type}/${path}?limit=${limit}`;
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    ...(Env.TRAKT_CLIENT_ID ? { 'trakt-api-key': Env.TRAKT_CLIENT_ID } : {})
  };
  const r = await fetch(url, { headers });
  if (!r.ok) return [];
  const data = await r.json();
  // normalize: Trakt returns { movie/show: { ids: { imdb }, title, year } }
  return data.map(row => {
    const obj = row.movie || row.show || row;
    const imdb = obj?.ids?.imdb;
    if (!imdb || !/^tt\d+/.test(imdb)) return null;
    return {
      id: imdb,
      title: obj.title,
      year: obj.year,
      // poster/genres/rating will be filled from Cinemeta lazily when needed
      poster: '',
