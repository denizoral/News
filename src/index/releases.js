// Release coverage: for each model in the releases list, the articles and
// posts in the permanent index that name it since launch, a count per day,
// and who wrote about it first.
//
// Matching is a phrase search on the release name in titles and descriptions,
// then a check on the text itself: FTS splits "5.5" into two tokens, so
// "Claude Opus 5" would otherwise match every "Claude Opus 5.5" story. Names
// that are one plain word ("Flint", "Extract") must appear with the lab's name.
// Model repo pages, "now available on OpenRouter" notices and translations
// of the same article aren't coverage.
//
// ~130 releases take ~200 ms, so it runs in the history worker, cached.

import { cachedJob, expireJob } from './offload.js';
import { headKey } from './topics.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
const MAX_DAYS = 30;
const ts = 'COALESCE(d.published_at, d.first_seen)';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (s) => `"${s.replace(/"/g, '')}"`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// "GPT-6 Astra" also matches "GPT 6 Astra" and "gpt-6-astra", and "Qwen3.8"
// matches "Qwen 3.8", but not "GPT-6 Astra2" or "GPT-6.1".
export function nameMatcher(name) {
  const parts = name.trim().replace(/([a-z])(\d)/gi, '$1 $2').split(/[\s\-_]+/).filter(Boolean).map(escRe);
  return new RegExp(`(?<![\\w.])${parts.join('[\\s\\-_]*')}(?![\\w]|[.\\-]\\d)`, 'i');
}

const plainWord = (name) => /^[a-z]+$/i.test(name.trim());

// Repo pages and model listings, not reporting.
const NOT_COVERAGE = /^https?:\/\/(?:www\.)?(?:openrouter\.ai|(?:[\w-]+\.)?huggingface\.co\/(?!blog\/|papers\/)|github\.com\/[^/]+\/[^/]+\/?$)/i;

function isCoverage(row) {
  return !NOT_COVERAGE.test(row.url) && !/ · Hugging Face$/.test(row.title) && !/is now available on OpenRouter/i.test(row.title);
}

const platformOf = (url) => (/^https:\/\/x\.com\//.test(url) ? 'x' : /reddit\.com/.test(url) ? 'reddit' : /news\.ycombinator\.com/.test(url) ? 'hn' : null);

export function releaseCoverage(db, r, { now = Date.now(), perRelease = 8 } = {}) {
  const since = r.date - DAY; // announcements and leaks a day ahead of the listing
  const until = Math.min(now, r.date + MAX_DAYS * DAY);
  // FTS reads "Qwen3.8" as qwen3 + 8 and "Qwen 3.8" as qwen + 3 + 8; ask for both.
  const spaced = r.name.replace(/([a-z])(\d)/gi, '$1 $2');
  let match = `{title description}: (${phrase(r.name)}${spaced !== r.name ? ` OR ${phrase(spaced)}` : ''})`;
  if (plainWord(r.name)) match += ` AND {title description}: ${phrase(r.provider)}`;
  let rows;
  try {
    rows = db.prepare(`SELECT d.id, d.url, d.title, d.description, d.site, d.source, d.type, d.engagement, ${ts} AS at FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ? AND ${ts} >= ? AND ${ts} <= ? AND d.hidden = 0 AND d.type IN ('article', 'post') AND d.title != ''
        AND (d.lang IS NULL OR d.lang = '' OR d.lang LIKE 'en%')`).all(match, since, until + 5 * 60e3);
  } catch {
    return null; // a name FTS can't parse
  }
  const re = nameMatcher(r.name);
  const heads = new Map();
  for (const row of rows) {
    if (!isCoverage(row)) continue;
    const inTitle = re.test(row.title);
    if (!inTitle && !re.test(row.description || '')) continue;
    const k = headKey(row.title);
    const h = heads.get(k);
    if (h) {
      h.outlets.add(row.site);
      h.engagement += row.engagement || 0;
      h.inTitle ||= inTitle;
      if (row.at < h.at) Object.assign(h, { at: row.at, url: row.url, site: row.site, source: row.source || row.site });
    } else {
      heads.set(k, { title: row.title, url: row.url, site: row.site, source: row.source || row.site, at: row.at, type: row.type, platform: platformOf(row.url), inTitle, engagement: row.engagement || 0, outlets: new Set([row.site]) });
    }
  }
  const all = [...heads.values()];
  if (!all.length) return { n: 0, outlets: 0, first: null, items: [], series: [] };

  // Mentions per day from the day before launch, so a leak shows up as a bar.
  const counts = new Map();
  for (const h of all) counts.set(dayOf(h.at), (counts.get(dayOf(h.at)) || 0) + 1);
  const series = [];
  for (let t = new Date(dayOf(since)).getTime(); t <= until; t += DAY) series.push({ day: dayOf(t), n: counts.get(dayOf(t)) || 0 });

  // Credit for first goes to an article with the model in its headline, not a
  // roundup that mentions it in passing.
  const shape = ({ outlets, engagement, inTitle, ...h }) => ({ ...h, outlets: outlets.size });
  const pool = [(h) => h.type === 'article' && h.inTitle, (h) => h.inTitle, () => true].map((f) => all.filter(f)).find((l) => l.length);
  const first = pool.reduce((a, b) => (b.at < a.at ? b : a));
  const items = all
    .sort((a, b) => b.inTitle - a.inTitle || b.outlets.size - a.outlets.size || (a.type === 'article' ? 0 : 1) - (b.type === 'article' ? 0 : 1) || b.engagement - a.engagement || a.at - b.at)
    .slice(0, perRelease)
    .map(shape);
  return {
    n: all.length,
    outlets: new Set(all.flatMap((h) => [...h.outlets])).size,
    first: shape(first),
    items,
    series,
  };
}

// { [release id]: coverage } for every release in the list.
export function computeReleaseCoverage(db, releases, opts = {}) {
  const out = {};
  for (const r of releases) {
    const c = releaseCoverage(db, r, opts);
    if (c) out[r.id] = c;
  }
  return out;
}

// The worker gets only what matching needs. When the list changes, the last
// result is still served while the new one is computed.
let listStamp = '';
export function releasesCoverage(releases) {
  const slim = releases.map(({ id, name, provider, date }) => ({ id, name, provider, date }));
  const stamp = slim.map((r) => r.id).join('|');
  if (stamp !== listStamp) {
    listStamp = stamp;
    expireJob('releases');
  }
  return cachedJob('releases', { kind: 'releases', releases: slim }, TTL_MS);
}

// Counts for the list view; the full entry comes from /api/release.
export const coverageCounts = (all) =>
  Object.fromEntries(Object.entries(all).map(([id, c]) => [id, { n: c.n, outlets: c.outlets }]));
