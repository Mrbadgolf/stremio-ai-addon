// index.js
import express from "express";
import cors from "cors";
import { addonBuilder } from "stremio-addon-sdk";
import LRU from "lru-cache";
import { fetch } from "undici";
import pino from "pino";
import { z } from "zod";

/* -------------------- CONFIG / ENV -------------------- */
const Env = z.object({
  PORT: z.string().optional(),             // required by Railway/Render/etc
  TRAKT_CLIENT_ID: z.string().optional(),  // recommended for Trakt quotas
  RD_API_KEY: z.string().optional()        // optional (streams)
}).safeParse(process.env);

const PORT = Number((Env.success && Env.data.PORT) || 8080);
const TRAKT_ID = (Env.success && Env.data.TRAKT_CLIENT_ID) || "";
const RD_KEY   = (Env.success && Env.data.RD_API_KEY) || "";

const log = pino({ level: "info" });

/* -------------------- MANIFEST -------------------- */
/** v3 ids/version to bust any old Stremio cache */
const MANIFEST = {
  id: "com.mrbadgolf.stremio-ai-rd",
  version: "1.4.4",
  name: "AI + RD (IMDb + Trakt)",
  description: "Dynamic catalogs via Trakt + Cinemeta (no TMDB). RD-ready.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    { type: "movie",  id: "ai-movies-v3", name: "AI Picks (Movies)",  extraSupported: ["skip"] },
    { type: "series", id: "ai-series-v3", name: "AI Picks (Series)",  extraSupported: ["skip"] },
    { type: "movie",  id: "trending-v3",  name: "Trending",           extraSupported: ["skip"] },
    { type: "movie",  id: "quality-v3",   name: "Quality Selections", extraSupported: ["skip"] }
  ]
};

/* -------------------- CACHES -------------------- */
const sixHoursMs = 1000 * 60 * 60 * 6;
const cache = new LRU({ max: 1500, ttl: sixHoursMs });

/* -------------------- SAFE NET HELPERS -------------------- */
async function safeJson(url, headers = {}, { label = "fetch", timeoutMs = 10000 } = {}) {
  try {
    const r = await fetch(url, { headers, dispatcher: undefined, bodyTimeout: timeoutMs, headersTimeout: timeoutMs });
    if (!r.ok) {
      log.warn({ label, url, status: r.status }, "http.nonOk");
      return null;
    }
    return await r.json();
  } catch (e) {
    log.warn({ label, url, err: String(e) }, "http.fail");
    return null;
  }
}

/* -------------------- DATA SOURCES (NO TMDB) -------------------- */
// Trakt public lists -> IMDb ids (no OAuth needed)
async function traktList({ type = "movies", path = "trending", limit = 100, page = 1 }) {
  const url = `https://api.trakt.tv/${type}/${path}?page=${page}&limit=${Math.min(limit, 100)}`;
  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    ...(TRAKT_ID ? { "trakt-api-key": TRAKT_ID } : {})
  };
  const data = await safeJson(url, headers, { label: `trakt:${type}/${path}` });
  if (!Array.isArray(data)) return [];
  const items = [];
  for (const row of data) {
    const obj = row.movie || row.show || row;
    const imdb = obj?.ids?.imdb;
    if (!imdb || !/^tt\d+/.test(imdb)) continue;
    const isMovie = Boolean(row.movie || type === "movies");
    const isShow  = Boolean(row.show  || type === "shows");
    items.push({
      id: imdb,
      title: obj.title || "Untitled",
      year: obj.year || undefined,
      poster: "",         // will be filled by Cinemeta
      genres: [],
      rating: 0,
      type: isMovie ? "movie" : (isShow ? "series" : "movie")
    });
  }
  return items;
}

// Cinemeta by IMDb id -> poster/genres/desc (no key needed)
async function fetchCinemetaMeta(type, imdbId) {
  const key = `cinemeta:${type}:${imdbId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const data = await safeJson(url, { "User-Agent": "stremio-addon" }, { label: "cinemeta" });
  // If Cinemeta fails, return a minimal meta (avoid throwing)
  if (!data || !data.meta) {
    const minimal = { id: imdbId, type, name: "Unknown", description: "", poster: "", genres: [], year: undefined };
    cache.set(key, minimal);
    return minimal;
  }
  const m = data.meta;
  const meta = {
    id: imdbId,
    type,
    name: m?.name || m?.title || m?.originalName || "Unknown",
    description: m?.description || m?.overview || "",
    poster: m?.poster || m?.background || "",
    genres: Array.isArray(m?.genres) ? m.genres : [],
    year: m?.releaseInfo ? Number(String(m.releaseInfo).slice(0, 4)) : (m?.year || undefined)
  };
  cache.set(key, meta);
  return meta;
}

/* -------------------- ENRICHMENT & ROWS -------------------- */
async function enrichKeep(items, typeHint) {
  // Try Cinemeta for each, but KEEP the item even if it fails (poster may be empty)
  const top = items.slice(0, 200);
  const out = [];
  for (const it of top) {
    const t = it.type || typeHint || "movie";
    const m = await fetchCinemetaMeta(t, it.id).catch(() => null);
    if (m && m.id) {
      out.push({
        id: m.id,
        title: m.name || it.title,
        year: m.year || it.year,
        poster: m.poster || it.poster || "",
        description: m.description || "",
        genres: Array.isArray(m.genres) ? m.genres : (it.genres || []),
        rating: it.rating || 0,
        type: m.type || it.type || t
      });
    } else {
      out.push(it); // fallback minimal
    }
  }
  // De-dup by IMDb id
  const seen = new Set();
  return out.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

async function buildRows({ wantMany = false }) {
  const [trendMovies, popMovies, trendShows] = await Promise.all([
    traktList({ type: "movies", path: "trending", limit: 100 }),
    traktList({ type: "movies", path: "popular",  limit: 100 }),
    traktList({ type: "shows",  path: "trending", limit: 100 })
  ]);

  // Quality = intersection of trending & popular (fallback to trending if too small)
  const popSet = new Set(popMovies.map(x => x.id));
  let qualityBase = trendMovies.filter(x => popSet.has(x.id));
  if (qualityBase.length < 30) qualityBase = trendMovies;

  const [aiMovies, aiSeries, trending, quality] = await Promise.all([
    enrichKeep(trendMovies, "movie"),
    enrichKeep(trendShows,  "series"),
    enrichKeep(trendMovies, "movie"),
    enrichKeep(qualityBase, "movie")
  ]);

  const cap = wantMany ? 200 : 50;
  return [
    { id: "ai-movies", title: "AI Picks (Movies)",   items: aiMovies.slice(0, cap) },
    { id: "ai-series", title: "AI Picks (Series)",   items: aiSeries.slice(0, cap) },
    { id: "trending",  title: "Trending Now",        items: trending.slice(0, cap) },
    { id: "quality",   title: "Quality Selections",  items: quality.slice(0, cap) }
  ];
}

/* -------------------- PERSONALIZATION (LIGHT) -------------------- */
function buildUserVec(events) {
  const weights = { complete: 3, like: 2.5, start: 1.0, abandon: -0.5 };
  const vec = {};
  for (const e of events || []) {
    const w = (weights[e.type] || 0.5) * (1 + (e.progress || 0));
    for (const t of (e.tags || [])) {
      const k = String(t).toLowerCase();
      vec[k] = (vec[k] || 0) + w;
    }
  }
  return vec;
}
function tagsToVec(tags) { const v = {}; for (const t of (tags || [])) v[String(t).toLowerCase()] = 1; return v; }
function cosine(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) { const va = a[k] || 0, vb = b[k] || 0; dot += va * vb; na += va * va; nb += vb * vb; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function rerank(items, userVec, diversify = true) {
  const scored = (items || []).map(it => {
    const sim = cosine(userVec, tagsToVec(it.genres || [])) || 0;
    const rating = it.rating || 0;
    const recency = it.year ? (1 + (it.year - 2015) * 0.03) : 1;
    return { it, score: rating * 0.7 + sim * 2.5 + recency * 0.3 };
  }).sort((a, b) => b.score - a.score);

  if (!diversify) return scored.map(s => s.it);
  const seen = new Set(), out = [];
  for (const s of scored) {
    const key = (s.it.genres || []).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.it);
  }
  for (const s of scored) if (!out.includes(s.it)) out.push(s.it);
  return out;
}

/* -------------------- STREMIO ADDON -------------------- */
const builder = new addonBuilder(MANIFEST);

// Catalog with pagination & robust fallback
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const skip  = Number((extra && extra.skip) || 0);
    const limit = Math.min(Number((extra && extra.limit) || 50), 100);

    const rows  = await buildRows({ wantMany: true });
    const row   = pickRowForCatalog(id, rows);
    const items = (row?.items && row.items.length ? row.items : (rows.find(r => r.items?.length)?.items || []));

    // Page, then map to metas; filter out those without posters (Stremio hides them anyway)
    const page  = items.slice(skip, skip + limit);
    const metas = page.map(it => toStremioMeta(it, type)).filter(Boolean);

    log.info({ catalog: id, type, skip, limit, total: items.length, returned: metas.length }, "catalog.page");
    return { metas };
  } catch (e) {
    log.error({ err: String(e) }, "catalog.error");
    return { metas: [] };
  }
});

// Meta via Cinemeta (never throws)
builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const meta = await fetchCinemetaMeta(type, id);
    return { meta };
  } catch (e) {
    log.error({ err: String(e), id, type }, "meta.error");
    return { meta: { id, type, name: "Unknown" } };
  }
});

// Streams (RD stub so it never crashes)
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const streams = await streamsFromRealDebrid(id, type);
    return { streams };
  } catch (e) {
    log.error({ err: String(e) }, "stream.error");
    return { streams: [] };
  }
});

// helpers
function pickRowForCatalog(catalogId, rows) {
  if (catalogId === "trending-v3")  return rows.find(r => r.id === "trending");
  if (catalogId === "quality-v3")   return rows.find(r => r.id === "quality");
  if (catalogId === "ai-movies-v3") return rows.find(r => r.id === "ai-movies");
  if (catalogId === "ai-series-v3") return rows.find(r => r.id === "ai-series");
  return rows[0];
}
function toStremioMeta(it, forcedType) {
  if (!it || !it.id || !it.title) return null;
  const poster = it.poster || "";         // Stremio often hides items without a poster
  if (!poster) return null;
  return {
    id: it.id,
    type: forcedType || it.type || "movie",
    name: it.title,
    poster,
    description: it.description || "",
    genres: it.genres || [],
    year: it.year
  };
}

/* -------------------- RD STREAMS (SAFE STUB) -------------------- */
async function streamsFromRealDebrid(imdbId, type = "movie") {
  // TODO: integrate RD (instant availability + unrestrict). Keep safe default:
  return [];
}

/* -------------------- EXPRESS SERVER -------------------- */
const app = express();
app.use(cors());
app.use(express.json());

// health
app.get("/health", (_req, res) => res.json({ ok: true }));

// optional: learning API (can be ignored)
const userEvents = new Map();
app.post("/api/events", (req, res) => {
  try {
    const { userId, imdb, type, progress = 0, ts = Date.now(), tags = [] } = req.body || {};
    if (!userId || !imdb || !type) return res.status(400).json({ error: "userId, imdb, type required" });
    const arr = userEvents.get(userId) || [];
    arr.push({ imdb, type, progress, ts, tags });
    userEvents.set(userId, arr);
    return res.json({ ok: true });
  } catch (e) {
    log.warn({ err: String(e) }, "events.error");
    return res.json({ ok: false });
  }
});
app.get("/api/feed", async (req, res) => {
  try {
    const userId = String(req.query.userId || "anon");
    const events = userEvents.get(userId) || [];
    const userVec = buildUserVec(events);
    const rows = await buildRows({ wantMany: true });
    const personalized = rows.map(r => ({ ...r, items: rerank(r.items, userVec).slice(0, 100) }));
    return res.json({ rows: personalized });
  } catch (e) {
    log.warn({ err: String(e) }, "feed.error");
    return res.json({ rows: [] });
  }
});

// mount Stremio endpoints
const stremioInterface = builder.getInterface();
app.get("/manifest.json", stremioInterface);
app.get("/catalog/:type/:id.json", stremioInterface);
app.get("/meta/:type/:id.json", stremioInterface);
app.get("/stream/:type/:id.json", stremioInterface);

// boot
app.listen(PORT, () => log.info({ port: PORT, trakt: Boolean(TRAKT_ID) }, "service.up"));
