// Outlets: who publishes what. For every site with enough AI coverage in the
// last 90 days: how much it publishes, which companies and themes it covers
// more than everyone else does (its "beat"), when it publishes, who writes
// for it, and which outlets cover the same things.
//
// One scan of the window's articles (~60k rows, ~1 s) feeds the directory and
// every profile; the worker keeps it for 30 minutes. A profile adds that
// site's year of weekly volume and its latest headlines.

import { extractEntities, isAiRelated } from '../pipeline/classify.js';
import { topicLabel } from './topics.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const WEEK = 7 * DAY;
const WINDOW_DAYS = 90;
const MIN_AI = 20; // AI articles in the window to get a profile
const SCAN_TTL = 30 * 60e3;
const EN = "(lang IS NULL OR lang = '' OR lang LIKE 'en%')";
// Model cards, repos, papers and link aggregators aren't outlets.
export const NOT_OUTLETS = ['huggingface.co', 'github.com', 'openrouter.ai', 'arxiv.org', 'x.com', 'reddit.com', 'news.ycombinator.com', 'bsky.app', 'youtube.com', 'news.google.com'];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mode = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

// A site key from user input: lower case, no scheme, no www.
export const siteKey = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

// Per-site tallies over the window, and the same tallies for all outlets.
export function scanOutlets(db, { now = Date.now(), days = WINDOW_DAYS } = {}) {
  const since = now - days * DAY;
  const weeks = Math.ceil(days / 7);
  const rows = db.prepare(`SELECT site, source, author, published_at AS at, title, substr(description, 1, 300) AS description, word_count AS words FROM docs
    WHERE published_at >= ? AND published_at <= ? AND hidden = 0 AND type = 'article' AND ${EN}
      AND site NOT IN (${NOT_OUTLETS.map(() => '?').join(',')})`).all(since, now + 3600e3, ...NOT_OUTLETS);
  const sites = new Map();
  const all = { ai: 0, entities: new Map() };
  for (const r of rows) {
    if (!r.site) continue;
    let s = sites.get(r.site);
    if (!s) {
      s = { site: r.site, n: 0, ai: 0, names: new Map(), entities: new Map(), weeks: new Array(weeks).fill(0), hours: new Array(24).fill(0), weekdays: new Array(7).fill(0), midnight: 0, words: [], authors: new Map() };
      sites.set(r.site, s);
    }
    s.n++;
    bump(s.names, r.source || r.site);
    const text = `${r.title} ${r.description || ''}`;
    if (!isAiRelated(text)) continue;
    s.ai++;
    all.ai++;
    for (const k of extractEntities(text).keys()) {
      bump(s.entities, k);
      bump(all.entities, k);
    }
    const w = Math.min(weeks - 1, Math.floor((now - r.at) / WEEK));
    if (w >= 0) s.weeks[weeks - 1 - w]++;
    const d = new Date(r.at);
    // Feeds that only give a date put everything at midnight.
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) s.midnight++;
    s.hours[d.getUTCHours()]++;
    s.weekdays[(d.getUTCDay() + 6) % 7]++;
    if (r.words > 150) s.words.push(r.words);
    const a = (r.author || '').trim();
    if (a && a.length < 60 && !/^(?:staff|admin|editor|editorial|team|news|guest)\b/i.test(a) && a.toLowerCase() !== (r.source || '').toLowerCase()) bump(s.authors, a);
  }
  return { at: now, since, days, weeks, sites, all };
}

// The companies and themes a site names more often than all outlets do.
export function beatOf(s, all, { min = 3, limit = 8 } = {}) {
  const out = [];
  for (const [key, n] of s.entities) {
    if (n < min) continue;
    const share = n / s.ai;
    const base = (all.entities.get(key) || 0) / Math.max(1, all.ai);
    out.push({ key, label: topicLabel(key), n, share: +share.toFixed(4), base: +base.toFixed(4), lift: +(share / Math.max(base, 1e-4)).toFixed(2) });
  }
  return out.filter((t) => t.lift >= 1.25).sort((a, b) => b.lift * Math.log1p(b.n) - a.lift * Math.log1p(a.n)).slice(0, limit);
}

// How alike two sites' beats are: cosine of their entity mixes after taking
// out what everyone covers (share minus the all-outlet share, scaled like a
// chi-square residual), so two outlets aren't "alike" just for both
// covering OpenAI.
function residuals(s, all) {
  const out = new Map();
  for (const [k, n] of s.entities) {
    const base = (all.entities.get(k) || 0) / Math.max(1, all.ai);
    if (base > 0) out.set(k, (n / s.ai - base) / Math.sqrt(base));
  }
  return out;
}
export function mixSimilarity(a, b, all) {
  const ra = a.res || (a.res = residuals(a, all));
  const rb = b.res || (b.res = residuals(b, all));
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of ra) {
    na += x * x;
    const y = rb.get(k);
    if (y) dot += x * y;
  }
  for (const y of rb.values()) nb += y * y;
  return dot / Math.sqrt(na * nb || 1);
}

const nameOf = (s) => mode(s.names) || s.site;
const listed = (scan) => [...scan.sites.values()].filter((s) => s.ai >= MIN_AI);

export function computeOutlets(db, { now = Date.now(), scan = scanOutlets(db, { now }) } = {}) {
  const rows = listed(scan).map((s) => ({
    site: s.site,
    name: nameOf(s),
    n: s.n,
    ai: s.ai,
    aiShare: +(s.ai / s.n).toFixed(3),
    perWeek: +(s.ai / (scan.days / 7)).toFixed(1),
    weeks: s.weeks,
    beat: beatOf(s, scan.all, { limit: 3 }).map((t) => ({ key: t.key, label: t.label })),
    words: median(s.words),
  })).sort((a, b) => b.ai - a.ai);
  return { days: scan.days, since: scan.since, generatedAt: now, total: rows.length, articles: scan.all.ai, outlets: rows };
}

export function computeOutlet(db, { site, now = Date.now(), scan = scanOutlets(db, { now }) }) {
  const s = scan.sites.get(site);
  if (!s || s.ai < MIN_AI) return null;
  // A year of weekly volume (all articles, AI or not), oldest first.
  const yearSince = now - 52 * WEEK;
  const year = new Array(52).fill(0);
  for (const r of db.prepare(`SELECT published_at AS at FROM docs WHERE site = ? AND type = 'article' AND hidden = 0 AND published_at >= ?`).all(site, yearSince)) {
    const w = Math.floor((now - r.at) / WEEK);
    if (w >= 0 && w < 52) year[51 - w]++;
  }
  const life = db.prepare(`SELECT COUNT(*) AS n, MIN(published_at) AS first FROM docs WHERE site = ? AND type = 'article' AND hidden = 0`).get(site);
  const latest = db.prepare(`SELECT title, url, published_at AS at, author FROM docs WHERE site = ? AND type = 'article' AND hidden = 0 AND published_at <= ? ORDER BY published_at DESC LIMIT 40`).all(site, now + 3600e3)
    .filter((r, i, a) => isAiRelated(r.title) && a.findIndex((x) => x.title === r.title) === i).slice(0, 10);
  const similar = listed(scan).filter((o) => o.site !== site)
    .map((o) => ({ site: o.site, name: nameOf(o), score: mixSimilarity(s, o, scan.all), ai: o.ai }))
    .sort((a, b) => b.score - a.score).slice(0, 6)
    .map((o) => ({ ...o, score: +o.score.toFixed(3) }));
  const timed = s.ai - s.midnight;
  const covered = [...s.entities].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, n]) => ({ key, label: topicLabel(key), n, share: +(n / s.ai).toFixed(4) }));
  return {
    site,
    name: nameOf(s),
    days: scan.days,
    generatedAt: now,
    totals: { ai: s.ai, all: s.n, aiShare: +(s.ai / s.n).toFixed(3), perWeek: +(s.ai / (scan.days / 7)).toFixed(1), lifetime: life.n, since: life.first },
    year: { from: yearSince, weeks: year },
    beat: beatOf(s, scan.all),
    covered,
    // Hours only when the feed gives real times.
    hours: timed >= s.ai * 0.6 ? s.hours.map((n, h) => (h === 0 ? n - s.midnight : n)) : null,
    weekdays: s.weekdays,
    words: median(s.words),
    authors: [...s.authors].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })),
    similar,
    latest,
  };
}

// ---- Worker side: one scan shared by the directory and profiles ----

let shared = null;
export function outletScan(db) {
  if (!shared || Date.now() - shared.at > SCAN_TTL) shared = scanOutlets(db);
  return shared;
}

// ---- Server side ----

export const outletsQuery = () => cachedJob('outlets', { kind: 'outlets' }, 30 * 60e3);
export const outletQuery = (site) => cachedJob(`outlet:${site}`, { kind: 'outlet', site }, 30 * 60e3);
