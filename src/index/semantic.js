// Semantic search and related coverage on top of vectors.js.
//
// The query or story text is embedded by the classifier service here; the
// nearest stored documents are found in the history worker (`similarDocs`),
// which keeps every vector in memory.

import { tokens } from '../pipeline/text.js';
import { DIM, embedTexts, VectorIndex } from './vectors.js';
import { runJob } from './offload.js';

const MAX_PAGE = 5;
const esc = (t = '') => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- Worker side ----

let index = null;
const headKey = (title) => tokens(title).slice(0, 6).join(' ');
const tokenSet = (s) => new Set(tokens(s));
function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
}

// A story page asks twice with the same vector (X reactions, then background):
// the second reuses the first scan when it needs no more candidates.
let last = null;
function nearest(vec, k) {
  const key = vec.length + ':' + vec.slice(0, 24).join(',');
  if (last && last.key === key && last.k >= k && last.n === index.n) return last.hits.slice(0, k);
  const hits = index.search(vec, k);
  last = { key, k, n: index.n, hits };
  return hits;
}

// Nearest documents to `vec`, newest copy of each headline once.
// `excludeUrls` and `excludeTitle` drop the story itself and its copies.
// `until` and `sites` narrow it to a time window and to some sites ("x.com").
export function similarDocs(db, { vec, page = 1, perPage = 10, types = ['article', 'post'], since = 0, until = Infinity, sites = null, minScore = 0, excludeUrls = [], excludeTitle = '' }) {
  index ||= new VectorIndex(db);
  index.refresh();
  const want = page * perPage;
  // A time window or site filter drops most neighbours, so look further.
  const narrow = sites || until !== Infinity || since > 0;
  const hits = nearest(vec, narrow ? Math.max(800, want * 20) : want * 4 + 40).filter((h) => h.score >= minScore);
  if (!hits.length) return { results: [], total: 0, indexed: index.n };
  const rows = new Map(db.prepare(`SELECT id, url, type, title, description, site, source, author, image_url, published_at, first_seen, meta FROM docs
    WHERE id IN (${hits.map(() => '?').join(',')}) AND hidden = 0`).all(...hits.map((h) => h.id)).map((r) => [r.id, r]));
  const skipUrls = new Set(excludeUrls);
  const own = excludeTitle ? tokenSet(excludeTitle) : null;
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const r = rows.get(h.id);
    if (!r || !types.includes(r.type) || skipUrls.has(r.url)) continue;
    const at = r.published_at || r.first_seen;
    if (at < since || at > until || (sites && !sites.includes(r.site))) continue;
    if (own && overlap(own, tokenSet(r.title)) >= 0.6) continue;
    const k = headKey(r.title);
    if (seen.has(k)) continue;
    seen.add(k);
    let meta = null;
    try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { /* ignore */ }
    out.push({ id: r.id, url: r.url, type: r.type, title: r.title, snippet: esc((r.description || '').replace(/\s+/g, ' ').slice(0, 240)), site: r.site, source: r.source, author: r.author || null, publishedAt: r.published_at || null, image: r.image_url || null, meta, score: h.score });
  }
  return { results: out.slice((page - 1) * perPage, want), total: out.length, indexed: index.n };
}

// ---- Server side ----

const cache = new Map(); // key -> { at, data }
const TTL_MS = 5 * 60e3;
function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data);
  return compute().then((data) => {
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), data });
    return data;
  });
}

const TIME_SINCE = { day: 1, week: 7, month: 30, year: 365 };
const TYPES = { news: ['article'], posts: ['post'] };

// Search by meaning: same response shape as the keyword search.
export function semanticSearch(query, opts = {}) {
  const text = String(query || '').trim();
  const page = Math.min(MAX_PAGE, Math.max(1, Number(opts.page) || 1));
  const days = TIME_SINCE[opts.time];
  const types = TYPES[opts.type] || ['article', 'post'];
  const key = JSON.stringify([text, page, opts.time || '', types]);
  return cached(key, async () => {
    const started = Date.now();
    if (!text) return { query: '', mode: 'meaning', results: [], total: 0, page, perPage: 10, tookMs: 0, facets: {} };
    // bge models retrieve better with this instruction on short queries.
    const [vec] = await embedTexts([`Represent this sentence for searching relevant passages: ${text}`], { timeoutMs: 15000 });
    const r = await runJob({ kind: 'similar', vec, page, perPage: 10, types, since: days ? Date.now() - days * 86400e3 : 0, minScore: 0.5 });
    return { query: text, mode: 'meaning', results: r.results, total: Math.min(r.total, MAX_PAGE * 10), page, perPage: 10, tookMs: Date.now() - started, facets: {}, indexed: r.indexed };
  });
}

// Earlier and parallel coverage of a story that isn't the story itself.
export function relatedTo(story) {
  return cached(`rel:${story.id}`, async () => {
    const [vec] = await embedTexts([`${story.title}. ${(story.summary || '').slice(0, 200)}`], { timeoutMs: 15000 });
    const excludeUrls = [story.url, story.linkUrl, ...story.sources.map((s) => s.url)].filter(Boolean);
    const r = await runJob({ kind: 'similar', vec, perPage: 6, types: ['article'], minScore: 0.72, excludeUrls, excludeTitle: story.title });
    return { id: story.id, results: r.results.map(({ meta, author, type, ...x }) => x) };
  });
}

// Keeps the search worker's copy of the vectors current, so a query never
// waits for thousands of new rows (the backfill adds ~35 a second) to load.
export function keepVectorsWarm(everyMs = 5 * 60e3) {
  const warm = () => runJob({ kind: 'similar', vec: new Array(DIM).fill(0), perPage: 1, minScore: 1 }).catch(() => {});
  warm();
  setInterval(warm, everyMs).unref();
}
