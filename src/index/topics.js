// Topic pages: how much of all coverage a company or theme got each day over
// the last 30 days, and a dated timeline of its most-read stories, from every
// document in the permanent index (data/wire.db).
//
// Counting a busy topic ("OpenAI") over 30 days of FTS matches takes a second
// or more, and node:sqlite is synchronous, so the server runs the queries in a
// worker thread with its own read-only connection and caches the results.

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ENTITIES } from '../pipeline/classify.js';
import { ENTITY_LABELS } from '../pipeline/trending.js';
import { tokens } from '../pipeline/text.js';

const DAY = 86400e3;
const TTL_MS = 15 * 60e3;
const TYPES = "d.type IN ('article', 'post')";
const ts = 'COALESCE(d.published_at, d.first_seen)';

export const topicKeys = () => Object.keys(ENTITIES);
export const topicLabel = (key) => ENTITY_LABELS[key] || key;

const ftsOr = (cols, key) => `{${cols}}: (${ENTITIES[key].map((a) => `"${a.replace(/"/g, '')}"`).join(' OR ')})`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Day totals are shared by every topic; cached per connection for 10 minutes.
const totalsCache = new WeakMap();
function dayTotals(db, since, now) {
  const hit = totalsCache.get(db);
  if (hit && now - hit.at < 10 * 60e3 && hit.since <= since) return hit.map;
  // Two index-friendly halves; COALESCE() in the WHERE would scan every row (13 s).
  const map = new Map(db.prepare(`SELECT date(at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM (
      SELECT d.published_at AS at FROM docs d WHERE d.published_at >= ? AND d.hidden = 0 AND ${TYPES}
      UNION ALL SELECT d.first_seen FROM docs d WHERE d.published_at IS NULL AND d.first_seen >= ? AND d.hidden = 0 AND ${TYPES}
    ) GROUP BY day`).all(since, since).map((r) => [r.day, r.n]));
  totalsCache.set(db, { at: now, since, map });
  return map;
}

// Near-identical headlines (syndicated copies) show once per day.
const headKey = (title) => tokens(title).slice(0, 6).join(' ');

export function computeTopic(db, key, { now = Date.now(), days = 30, timelineDays = 14, perDay = 4 } = {}) {
  if (!ENTITIES[key]) return null;
  const start = new Date(dayOf(now - (days - 1) * DAY)).getTime();
  const totals = dayTotals(db, start, now);
  const counts = new Map(db.prepare(`SELECT date(${ts} / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
    WHERE docs_fts MATCH ? AND ${ts} >= ? AND d.hidden = 0 AND ${TYPES} GROUP BY day`).all(ftsOr('title description', key), start).map((r) => [r.day, r.n]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const day = dayOf(start + i * DAY);
    const n = counts.get(day) || 0;
    const total = totals.get(day) || 0;
    series.push({ day, n, total, share: total ? +(n / total).toFixed(4) : 0 });
  }

  // Timeline: articles with the topic in the headline (a passing mention in
  // a description isn't a story about it). Within a day, a headline that many
  // outlets ran ranks first; syndicated copies collapse into one entry.
  const tlStart = new Date(dayOf(now - (timelineDays - 1) * DAY)).getTime();
  const rows = db.prepare(`SELECT d.id, d.title, d.url, d.site, d.source, d.image_url AS image, ${ts} AS at, d.engagement FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
    WHERE docs_fts MATCH ? AND ${ts} >= ? AND ${ts} <= ? AND d.hidden = 0 AND d.type = 'article' AND d.title != ''
      AND (d.lang IS NULL OR d.lang = '' OR d.lang LIKE 'en%')`).all(ftsOr('title', key), tlStart, now + 5 * 60e3);
  const byDay = new Map();
  for (const r of rows) {
    const day = dayOf(r.at);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const heads = byDay.get(day);
    const k = headKey(r.title);
    const h = heads.get(k);
    if (h) {
      h.outlets.add(r.site);
      if (r.at < h.at) Object.assign(h, { at: r.at, id: r.id, url: r.url, site: r.site, source: r.source || r.site }); // credit the earliest copy
      h.image ||= r.image;
    } else {
      heads.set(k, { id: r.id, title: r.title, url: r.url, site: r.site, source: r.source || r.site, image: r.image || null, at: r.at, engagement: r.engagement, outlets: new Set([r.site]) });
    }
  }
  const timeline = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, heads]) => ({
      day,
      count: counts.get(day) || 0,
      items: [...heads.values()]
        .sort((a, b) => b.outlets.size - a.outlets.size || b.engagement - a.engagement || b.at - a.at)
        .slice(0, perDay)
        .map(({ outlets, engagement, ...h }) => ({ ...h, outlets: outlets.size })),
    }));

  const total = series.reduce((s, d) => s + d.n, 0);
  // Quiet days (weekends, crawler gaps) make shares jumpy; the peak needs volume.
  const busy = series.filter((d) => d.total >= 150 && d.n);
  const peak = busy.reduce((p, d) => (d.share > p.share ? d : p), busy[0]);
  return { key, label: topicLabel(key), aliases: ENTITIES[key], days, total, peak: peak?.n ? peak.day : null, series, timeline, generatedAt: now };
}

// ---- Serving: a worker thread and a cache in front of it ----

const cache = new Map(); // key -> { at, data } | { pending }
let worker = null;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./topics-worker.js', import.meta.url), {
    workerData: { file: path.resolve(process.env.DATA_DIR || 'data', 'wire.db') },
  });
  worker.unref();
  worker.on('message', ({ id, data, error }) => {
    const w = waiting.get(id);
    waiting.delete(id);
    if (w) (error ? w.reject(new Error(error)) : w.resolve(data));
  });
  const fail = (err) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    worker = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => code && fail(new Error(`topic worker exited with ${code}`)));
  return worker;
}

function runInWorker(key) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, key });
  });
}

// Cached for 15 minutes; a stale entry is served while it refreshes.
export function topicHistory(key) {
  if (!ENTITIES[key]) return Promise.resolve(null);
  const hit = cache.get(key);
  const fresh = hit?.data && Date.now() - hit.at < TTL_MS;
  if (fresh) return Promise.resolve(hit.data);
  if (!hit?.pending) {
    const pending = runInWorker(key)
      .then((data) => cache.set(key, { at: Date.now(), data }))
      .catch((err) => {
        if (hit?.data) cache.set(key, hit);
        else cache.delete(key);
        throw err;
      });
    cache.set(key, { ...hit, pending });
  }
  const entry = cache.get(key);
  return entry.data ? Promise.resolve(entry.data) : entry.pending.then(() => cache.get(key).data);
}

// Warms the cache for the topics people are most likely to open (trending
// ones), one at a time in the worker.
export async function warmTopics(keys) {
  for (const k of keys) await topicHistory(k).catch(() => {});
}
