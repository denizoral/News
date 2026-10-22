// Trends: how much of the coverage mentions a word or phrase, over time.
//
// Each term is counted per day or week across the permanent index, and divided
// by everything stored in that bucket, so a term's line doesn't rise just
// because we crawl more than we used to ("mentions per 1,000 stories"). The
// three highest buckets per term are its peaks, each with the headline that
// matched best then. Runs in the history worker (offload.js).

import { parseQuery, toMatch } from './search.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
export const RANGES = {
  '30d': { days: 30, bucket: 'day' },
  '90d': { days: 90, bucket: 'day' },
  '1y': { days: 365, bucket: 'week' },
  '2y': { days: 730, bucket: 'week' },
};
export const MAX_TERMS = 4;
const AT = 'COALESCE(d.published_at, d.first_seen)';
const KEEP = "d.hidden = 0 AND d.type != 'market'";

// Day number, or the Monday that starts the week (1970-01-01 was a Thursday).
export function bucketOf(ms, bucket) {
  const day = Math.floor(ms / DAY);
  return bucket === 'week' ? day - ((day + 3) % 7) : day;
}

// "openai, anthropic" -> [{ label, match }], at most four, no repeats.
export function parseTerms(input = '') {
  const seen = new Set();
  const out = [];
  for (const raw of String(input).split(',')) {
    const label = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    const match = toMatch(parseQuery(label));
    if (!match) continue;
    seen.add(key);
    out.push({ label, match: `{title description body} : (${match})` });
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

// Everything stored per bucket; the denominator. Shared by every query in
// the worker for ten minutes.
const totalsCache = new WeakMap(); // db -> bucket -> { at, since, map }
function totals(db, bucket, since) {
  if (!totalsCache.has(db)) totalsCache.set(db, new Map());
  const cache = totalsCache.get(db);
  const hit = cache.get(bucket);
  if (hit && Date.now() - hit.at < 10 * 60e3 && hit.since <= since) return hit.map;
  const from = Math.min(since, Date.now() - RANGES['2y'].days * DAY);
  const map = new Map();
  for (const r of db.prepare(`SELECT ${AT} AS t FROM docs d INDEXED BY docs_at WHERE ${AT} >= ? AND ${KEEP}`).iterate(from)) {
    const b = bucketOf(r.t, bucket);
    map.set(b, (map.get(b) || 0) + 1);
  }
  cache.set(bucket, { at: Date.now(), since: from, map });
  return map;
}

// Matches in [from, to) through the narrow docs_when index, best first; the
// full rows (with their bodies) are only read for the few kept.
const RANKED = `SELECT d.id FROM docs_fts JOIN docs d INDEXED BY docs_when ON d.id = docs_fts.rowid
  WHERE docs_fts MATCH ? AND ${KEEP} AND ${AT} >= ? AND ${AT} < ?
  ORDER BY bm25(docs_fts, 10, 3, 1, 0, 0) LIMIT ?`;

function bestDoc(db, match, from, to) {
  return db.prepare(`SELECT d.title, d.url, d.site, ${AT} AS at FROM docs d WHERE d.id IN (${RANKED}) AND d.title != '' LIMIT 1`).get(match, from, to, 3) || null;
}

// The `n` highest buckets, at least `gap` buckets apart, with three mentions or more.
export function pickPeaks(points, n = 3, gap = 4) {
  const order = points.map((p, i) => ({ ...p, i })).filter((p) => p.count >= 3).sort((a, b) => b.share - a.share);
  const out = [];
  for (const p of order) {
    if (out.every((q) => Math.abs(q.i - p.i) >= gap)) out.push(p);
    if (out.length === n) break;
  }
  return out.sort((a, b) => a.i - b.i);
}

export function computeTrends(db, { q, range = '1y', now = Date.now() }) {
  const terms = parseTerms(q);
  const r = RANGES[range] || RANGES['1y'];
  const step = r.bucket === 'week' ? 7 : 1;
  const first = bucketOf(now - r.days * DAY, r.bucket);
  const last = bucketOf(now, r.bucket);
  const since = first * DAY;
  const tot = totals(db, r.bucket, since);
  const buckets = [];
  for (let b = first; b <= last; b += step) buckets.push(b);
  const series = terms.map(({ label, match }) => {
    const counts = new Map();
    let total = 0;
    for (const row of db.prepare(`SELECT ${AT} AS t FROM docs_fts JOIN docs d INDEXED BY docs_when ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ? AND ${KEEP} AND ${AT} >= ?`).iterate(match, since)) {
      const b = bucketOf(row.t, r.bucket);
      if (b > last) continue;
      counts.set(b, (counts.get(b) || 0) + 1);
      total++;
    }
    const points = buckets.map((b) => {
      const count = counts.get(b) || 0;
      const all = tot.get(b) || 0;
      return { t: b * DAY, count, share: all ? Math.round((count / all) * 1e4) / 10 : 0 };
    });
    const peaks = pickPeaks(points).map((p) => ({ t: p.t, share: p.share, count: p.count, doc: bestDoc(db, match, p.t, p.t + step * DAY) }));
    // Latest four buckets against the four before; the current bucket is partial, so it is left out.
    const span = (a, z) => points.slice(a, z).reduce((s, p) => s + p.share, 0);
    const n = points.length;
    const before = span(n - 9, n - 5);
    const recent = span(n - 5, n - 1);
    const change = before > 0 ? Math.round(((recent - before) / before) * 100) : recent > 0 ? null : 0;
    return { label, total, change, points: points.map((p) => [p.t, p.share, p.count]), peaks };
  });
  return { range, bucket: r.bucket, terms: series, totals: buckets.map((b) => tot.get(b) || 0), generatedAt: now };
}

// The best-matching stories for one term in one bucket: what was said then.
export function trendMoment(db, { q, from, to, limit = 6 }) {
  const [term] = parseTerms(q);
  if (!term) return { docs: [] };
  const ids = db.prepare(RANKED).all(term.match, from, to, limit * 4).map((r) => r.id);
  const byId = new Map(db.prepare(`SELECT d.id, d.title, d.url, d.site, d.source, d.type, ${AT} AS at FROM docs d
    WHERE d.id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND d.title != ''`).all(...ids).map((d) => [d.id, d]));
  const docs = ids.map((id) => byId.get(id)).filter(Boolean);
  // One per headline: syndicated copies are the same story.
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const k = d.title.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
    if (out.length === limit) break;
  }
  return { label: term.label, from, to, docs: out };
}

// ---- Main thread: run in the history worker, cached ----

export const normTerms = (input) => parseTerms(input).map((t) => t.label.toLowerCase()).join(',');

export function trendsQuery(input, range = '1y') {
  const key = normTerms(input);
  const r = RANGES[range] ? range : '1y';
  return cachedJob(`trends:${r}:${key}`, { kind: 'trends', q: key, range: r }, 15 * 60e3);
}

export function trendMomentQuery(input, from, to) {
  const key = normTerms(input).split(',')[0];
  return cachedJob(`trendMoment:${key}:${from}:${to}`, { kind: 'trendMoment', q: key, from, to }, 30 * 60e3);
}
