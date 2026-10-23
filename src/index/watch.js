// Watchlists: searches a reader keeps (stored in their browser) and what's
// new for each since they last looked. A watch is any site search ("open
// weights", intitle:Rubin, site:theverge.com anthropic, -rumor); it matches
// headlines and summaries of articles and posts from the last 14 days.
// Each query's matches are read once in the history worker and cached for
// a few minutes; the server then counts what's newer than each reader's own
// last look, so the cache is shared by everyone watching the same thing.

import { parseQuery, toMatch } from './search.js';
import { splitOutlet } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
export const WATCH_DAYS = 14;
export const MAX_WATCHES = 12;
export const MAX_QUERY = 100;

export const normQuery = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);

// The FTS expression for a watch: title and summary only, so a word deep in
// an article body doesn't count as news about it.
export function watchMatch(q) {
  const p = parseQuery(q);
  const expr = toMatch(p);
  if (!expr) return null;
  return { p, match: p.intitle.length ? expr : `{title description} : (${expr})` };
}

export function computeWatch(db, { q, now = Date.now() }) {
  const w = watchMatch(q);
  if (!w) return { q, error: 'Type a word or phrase to watch.' };
  const since = now - WATCH_DAYS * DAY;
  const where = ["d.published_at >= ? AND d.published_at <= ? AND d.hidden = 0"];
  const args = [w.match, since, now + 5 * 60e3];
  if (w.p.type) { where.push('d.type = ?'); args.push(w.p.type); } else where.push("d.type IN ('article', 'post')");
  if (w.p.site) { where.push("(d.site = ? OR d.site LIKE '%.' || ?)"); args.push(w.p.site, w.p.site); }
  // Counts in ten-minute buckets (exact however broad the watch), and the
  // newest rows for the list.
  const BUCKET = 10 * 60e3;
  let buckets;
  let rows;
  try {
    const from = `FROM docs d WHERE d.id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND ${where.join(' AND ')}`;
    buckets = db.prepare(`SELECT d.published_at / ${BUCKET} AS b, COUNT(*) AS n ${from} GROUP BY b`).all(...args).map((r) => [Math.floor(r.b), r.n]);
    rows = db.prepare(`SELECT d.title, d.url, d.site, d.source, d.type, d.published_at AS at ${from} ORDER BY d.published_at DESC LIMIT 60`).all(...args);
  } catch {
    return { q, error: 'That search couldn’t be read. Try simpler words.' };
  }
  const days = [];
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = WATCH_DAYS - 1; i >= 0; i--) days.push({ d: new Date(start.getTime() - i * DAY).toISOString().slice(0, 10), n: 0 });
  const di = new Map(days.map((x, i) => [x.d, i]));
  for (const [b, n] of buckets) {
    const i = di.get(new Date(b * BUCKET).toISOString().slice(0, 10));
    if (i != null) days[i].n += n;
  }
  // The newest, one per headline wording.
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    const { title, outlet } = splitOutlet(r.title || '');
    const k = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 60);
    if (!title || seen.has(k)) continue;
    seen.add(k);
    items.push({ title, url: r.url, source: outlet || r.source || r.site, type: r.type, at: r.at });
    if (items.length === 8) break;
  }
  return { q, total: buckets.reduce((a, [, n]) => a + n, 0), days, buckets, bucket: BUCKET, items };
}

export const watchQuery = (q) => cachedJob(`watch:${q.toLowerCase()}`, { kind: 'watch', q }, 3 * 60e3);

// What one reader sees: each watch with how much is new since their last look.
export async function watchFor(list, now = Date.now()) {
  const out = [];
  for (const { q, since } of list) {
    const r = await watchQuery(q);
    if (r.error) { out.push({ q, error: r.error }); continue; }
    const from = Math.max(Number(since) || 0, now - WATCH_DAYS * DAY);
    // Buckets that start after the last look; within ten minutes of exact.
    const fresh = r.buckets.reduce((a, [b, n]) => a + (b * r.bucket >= from ? n : 0), 0);
    out.push({ q, total: r.total, fresh, days: r.days, items: r.items.map((it) => ({ ...it, fresh: it.at > from })) });
  }
  return out;
}
