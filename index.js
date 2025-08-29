// index.js
import { addonBuilder } from 'stremio-addon-sdk';
import express from 'express';
import cors from 'cors';
import LRU from 'lru-cache';
import { fetch } from 'undici';
import pino from 'pino';
import { z } from 'zod';

/* ---------- ENV ---------- */
const Env = z.object({
  TRAKT_CLIENT_ID: z.string().optional(), // strongly recommended
  RD_API_KEY: z.string().optional(),      // optional: Real-Debrid streams
  PORT: z.string().optional()
}).parse(process.env);

const log = pino({ level: 'info' });

/* ---------- MANIFEST ---------- */
const MANIFEST = {
  id: 'com.mrbadgolf.stremio-ai-rd',
  version: '1.4.0',
  name: 'AI + RD (IMDb + Trakt)',
  description: 'Large dynamic catalogs via Trakt + Cinemeta. RD streams ready.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie',  id: 'ai-movies', name: 'AI Picks (Movies)',  extraSupported: ['skip'] },
    { type: 'series', id: 'ai-series', name: 'AI Picks (Series)',  extraSupported: ['skip'] },
    { type: 'movie',  id: 'trending',  name: 'Trending',           extraSupported: ['skip'] },
    { type: 'movie',  id: 'quality',   name: 'Quality Selections', extraSupported: ['skip'] }
  ]
};

const cache = new LRU({ max: 1000, ttl: 1000 * 60 * 60 * 6 }); // 6h cache
const builder = new addonBuilder(MANIFEST);

/* ---------- STREMIO: CATALOG (with paging) ---------- */
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const userId = (extra && extra.userId) || 'anon';
  const skip = Number((extra && extra.skip) || 0);
  const limit = Math.min(Number((extra && extra.limit) || 50), 100);

  // build big pools; wantMany=true means fetch more than we show
  const rows = await buildRows({ userId, wantMany: true });
  let row = pickRowForCatalog(id, rows, type);

  // fallback if somehow empty
  let items = (row?.items && row.items.length ? row.items : (rows.find(r => r.items?.length)?.items || []));

  // page
  const page = items.slice(skip, skip + limit);
  const metas = page.map(toStremioMeta);

  log.info({ id, type, skip, limit, returned: metas.length }, 'catalog page');
  return { metas };
});

/* ---------- STREMIO: META (Cinemeta by IMDb) ---------- */
builder.defineMetaHandler(async ({ type, id }) => {
  const key = `meta:${type}:${id}`;
  const hit = cache.get(key); if (hit) return { meta: hit };
  const meta = await fetchCinemetaMeta(type, id);
  cache.set(key, meta);
  return { meta };
});

/* ---------- STREMIO: STREAM (plug your RD code) ---------- */
builder.defineStreamHandler(async ({ type, id }) => {
  const streams = await streamsFromRealDebrid(id, type);
  return { streams };
});

/* ---------- EXPRESS: API + MOUNT STREMIO ---------- */
const app = express();
app.use(cors());
app.use(express.json());

// health
app.get('/health', (_, res) => res.json({ ok: true }));

// (Optional) learning events: you can ignore this if you want a pure catalog
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
  const rows = await buildRows({ userId, wantMany: true });
  const personalized = rows.map(r => ({ ...r, items: rerank(r.items, userVec).slice(0, 100) }));
  res.json({ rows: personalized });
});

// mount Stremio interface
const stremioInterface = builder.getInterface();
app.get('/manifest.json', stremioInterface);
app.get('/catalog/:type/:id.json', stremioInterface);
app.get('/meta/:type/:id.json', stremioInterface);
app.get('/stream/:type/:id.json', stremioInterface);

const port = Number(Env.PORT || 8080);
app.listen(port, () => log.info({ port }, 'service up'));

/* ---------- HELPERS ---------- */
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
function rerank(items, userVec, diversify=true) {
  const scored = (items||[]).map(it => {
    const sim = cosine(userVec, tagsToVec(it.genres||[])) || 0;
    const rating = it.rating || 0;
    const recency = it.year ? (1 + (it.year - 2015) * 0.03) : 1;
    return { it, score: rating*0.7 + sim*2.5 + recency*0.3 };
  }).sort((a,b)=>b.score-a.score);

  if (!diversify) return scored.map(s=>s.it);
  const seen = new Set(), out=[];
  for (const s of scored) {
    const key=(s.it.genres||[]).join('|');
    if (seen.has(key)) continue;
    seen.add(key); out.push(s.it);
  }
  for (const s of scored) if (!out.includes(s.it)) out.push(s.it);
  return out;
}

/* ---------- DATA (NO TMDB) ---------- */
// Cinemeta by IMDb id
async function fetchCinemetaMeta(type, imdbId) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'stremio-addon' } });
  if (!r.ok) throw new Error(`Cinemeta ${r.status}`);
  const { meta } = await r.json();
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

// Trakt pools (uses only Client ID; no OAuth needed)
async function traktList({ type='movies', path='trending', limit=100, page=1 }) {
  const url = `https://api.trakt.tv/${type}/${path}?page=${page}&limit=${Math.min(limit,100)}`;
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    ...(Env.TRAKT_CLIENT_ID ? { 'trakt-api-key': Env.TRAKT_CLIENT_ID } : {})
  };
  const r = await fetch(url, { headers });
  if (!r.ok) return [];
  const data = await r.json();
  return data.map(row => {
    const obj = row.movie || row.show || row;
    const imdb = obj?.ids?.imdb;
    const isMovie = Boolean(row.movie || type === 'movies');
    const isShow  = Boolean(row.show  || type === 'shows');
    if (!imdb || !/^tt\d+/.test(imdb)) return null;
    return {
      id: imdb,
      title: obj.title,
      year: obj.year,
      poster: '',
      genres: [],
      rating: 0,
      type: isMovie ? 'movie' : (isShow ? 'series' : 'movie')
    };
  }).filter(Boolean);
}

// Enrich but KEEP items if Cinemeta fails (no more 3-item lists)
async function enrichKeep(items, typeHint) {
  const top = items.slice(0, 200);
  const out = [];
  for (const it of top) {
    try {
      const m = await fetchCinemetaMeta(it.type || typeHint || 'movie', it.id);
      out.push({
        id: m.id,
        title: m.name || it.title,
        year: m.year || it.year,
        poster: m.poster || it.poster,
        description: m.description || '',
        genres: Array.isArray(m.genres) ? m.genres : (it.genres || []),
        rating: it.rating || 0,
        type: m.type || it.type || typeHint || 'movie'
      });
    } catch {
      out.push(it); // keep minimal item
    }
  }
  const seen = new Set();
  return out.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

// Build big rows
async function buildRows({ userId, wantMany = false }) {
  const [tMovies, pMovies, tShows] = await Promise.all([
    traktList({ type: 'movies', path: 'trending',  limit: 100 }),
    traktList({ type: 'movies', path: 'popular',   limit: 100 }),
    traktList({ type: 'shows',  path: 'trending',  limit: 100 })
  ]);

  // Quality row = intersection; fallback to trending if small
  const popSet = new Set(pMovies.map(x => x.id));
  let qualityBase = tMovies.filter(x => popSet.has(x.id));
  if (qualityBase.length < 30) qualityBase = tMovies;

  const [aiMovies, aiSeries, trending, quality] = await Promise.all([
    enrichKeep(tMovies,     'movie'),
    enrichKeep(tShows,      'series'),
    enrichKeep(tMovies,     'movie'),
    enrichKeep(qualityBase, 'movie')
  ]);

  const cap = wantMany ? 200 : 50;
  return [
    { id: 'ai-movies', title: 'AI Picks (Movies)',   items: aiMovies.slice(0, cap) },
    { id: 'ai-series', title: 'AI Picks (Series)',   items: aiSeries.slice(0, cap) },
    { id: 'trending',  title: 'Trending Now',        items: trending.slice(0, cap) },
    { id: 'quality',   title: 'Quality Selections',  items: quality.slice(0, cap) }
  ];
}

/* ---------- Real-Debrid (stub) ---------- */
async function streamsFromRealDebrid(imdbId, type='movie') {
  // TODO: Replace with your RD logic (instant availability + unrestrict)
  // return [{ title: 'RD 1080p', url: 'https://...' }];
  return [];
}
