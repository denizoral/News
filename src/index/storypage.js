// Story pages (/api/story?id=<sid>): everything about one story in one place.
//   timeline   each outlet's first report, in order, with the lead marked
//   growth     outlets covering it over time (for the spread chart)
//   brief      an extractive summary across outlets (pipeline/brief.js)
//   reactions  X posts in the story, and close ones by meaning in its window
//   background earlier articles on the same subject (embeddings)
//   markets    linked prediction markets: odds history and the move since
//              the story broke
// A live story is read from the feed; one that has left it is rebuilt from
// story_log and the stored documents of every item that was ever in it.

import { q } from '../db.js';
import { canonicalUrl, hostOf } from '../pipeline/text.js';
import { extractiveBrief } from '../pipeline/brief.js';
import { marketHistory } from '../pipeline/odds.js';
import { loggedStory } from './stories.js';
import { embedTexts } from './vectors.js';
import { runJob } from './offload.js';
import { readyMoves, movesAfter } from './moves.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const TTL_MS = 2 * 60e3;
const RELAYS = new Set(['hn', 'reddit']); // discussion of an article, not a report

const nameOf = (it) => (it.platform === 'x' || it.platform === 'bluesky' ? `@${it.handle}` : it.source || it.sourceHost || hostOf(it.url));

function fromItem(it) {
  return {
    at: it.publishedAt || null,
    name: nameOf(it),
    platform: it.platform || 'web',
    host: it.sourceHost || hostOf(it.url),
    url: it.url,
    discussion: it.discussionUrl || null,
    title: it.title,
    summary: it.summary || '',
    kind: it.kind || null,
    avatar: it.avatar || null,
    handle: it.handle || null,
    engagement: it.engagement?.score || 0,
  };
}

function fromDoc(r) {
  let m = {};
  try { m = JSON.parse(r.meta || '{}') || {}; } catch {}
  return {
    at: r.published_at || r.first_seen,
    name: m.platform === 'x' ? `@${m.handle}` : r.source || r.site,
    platform: m.platform || 'web',
    host: r.site,
    url: r.url,
    discussion: m.discussionUrl || null,
    title: r.title,
    kind: null,
    avatar: m.avatar || null,
    handle: m.handle || null,
    engagement: r.engagement || 0,
  };
}

// Stored documents for item URLs (documents are keyed by canonical URL).
function docsByUrl(urls) {
  const keys = [...new Set(urls.map(canonicalUrl))];
  return keys.length
    ? q(`SELECT url, title, description, body, word_count, site, source, published_at, first_seen, engagement, meta FROM docs WHERE url IN (${keys.map(() => '?').join(',')}) AND hidden = 0`).all(...keys)
    : [];
}

// One entry per outlet (its first report), oldest first; X posts are reactions.
export function timelineOf(entries) {
  const reports = [];
  const seen = new Set();
  for (const e of [...entries].filter((e) => e.at).sort((a, b) => a.at - b.at)) {
    if (e.platform === 'x' || e.platform === 'bluesky') continue;
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    reports.push(e);
  }
  return reports;
}

// Distinct outlets (and X accounts) covering the story over time: [[t, n], ...].
export function growthOf(entries) {
  const seen = new Set();
  const out = [];
  for (const e of [...entries].filter((e) => e.at).sort((a, b) => a.at - b.at)) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push([e.at, seen.size]);
  }
  return out;
}

// The price of the leading outcome when the story broke against now.
export function marketMove(hist, firstAt) {
  const lead = hist[0];
  if (!lead?.points.length || lead.yes == null) return null;
  const before = lead.points.filter(([t]) => t <= firstAt).at(-1) || (lead.points[0][0] - firstAt < 6 * HOUR ? lead.points[0] : null);
  if (!before) return null;
  return { label: lead.label, from: before[1], to: lead.yes, change: +(lead.yes - before[1]).toFixed(3) };
}

// `shown` (the summary under the headline) isn't repeated in the brief.
function briefOf(entries, shown = '') {
  const reports = timelineOf(entries).filter((e) => !RELAYS.has(e.platform));
  const docs = new Map(docsByUrl(reports.slice(0, 24).map((e) => e.url)).map((r) => [r.url, r]));
  const texts = reports
    .slice(0, 24)
    .map((e) => {
      const d = docs.get(canonicalUrl(e.url));
      const body = d && d.word_count >= 80 ? d.body.slice(0, 6000) : '';
      return { source: e.name, url: e.url, text: [d?.description || e.summary || '', body].join(' ') };
    })
    .filter((d) => d.text.trim());
  const seen = norm(shown);
  return extractiveBrief(texts, { max: 5 }).filter((b) => !seen || !seen.includes(norm(b.text).slice(0, 60))).slice(0, 4);
}

const norm = (t = '') => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cache = new Map();

export async function storyPage(store, id, { now = Date.now() } = {}) {
  let live = store.live.get(id) || [...store.live.values()].find((s) => s.id === id) || null;
  let logged = null;
  if (!live) {
    logged = loggedStory(id);
    if (!logged) return null;
    // Merged into another live story since: show that one.
    const urls = new Set(logged.urls);
    live = [...store.live.values()].find((s) => s._group.some((it) => urls.has(it.url))) || null;
  }
  const sid = live?.sid || id;
  const hit = cache.get(sid);
  if (hit && now - hit.at < TTL_MS) return hit.data;

  const base = live || logged;
  const entries = live ? live._group.map(fromItem) : docsByUrl(logged.urls).map(fromDoc);
  const timeline = timelineOf(entries);
  const firstAt = timeline[0]?.at || base.publishedAt;
  const lastAt = Math.max(...entries.map((e) => e.at || 0), base.updatedAt || 0);
  const ownX = entries.filter((e) => e.platform === 'x' || e.platform === 'bluesky');

  // Meaning-based extras: skipped (not failed) if the classifier is down.
  let reactions = [], background = [];
  try {
    const [vec] = await embedTexts([`${base.title}. ${(base.summary || '').slice(0, 200)}`], { timeoutMs: 10000 });
    const excludeUrls = entries.map((e) => e.url);
    const [x, bg] = await Promise.all([
      runJob({ kind: 'similar', vec, perPage: 8, types: ['post'], sites: ['x.com'], since: firstAt - 12 * HOUR, until: Math.max(lastAt, firstAt) + 3 * DAY, minScore: 0.78, excludeUrls }),
      runJob({ kind: 'similar', vec, perPage: 5, types: ['article'], until: firstAt - 12 * HOUR, minScore: 0.7, excludeUrls, excludeTitle: base.title }),
    ]);
    reactions = x.results.map((r) => ({ at: r.publishedAt, name: r.source, handle: r.meta?.handle, avatar: r.meta?.avatar, url: r.url, title: r.title, engagement: 0, related: true }));
    background = bg.results.map(({ meta, author, type, snippet, ...r }) => r);
  } catch {}
  const seenX = new Set();
  reactions = [...ownX, ...reactions]
    .filter((r) => !seenX.has(r.url) && seenX.add(r.url))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(0, 12);

  // Odds jumps this story's coverage came just before, on any market.
  const allMoves = await readyMoves(store);
  const moved = allMoves ? movesAfter(allMoves, entries.map((e) => e.url)) : [];
  const marketIds = [...new Set([...(live ? (live.markets || []).map((m) => m.id) : logged.marketIds), ...moved.map((m) => m.market)])];
  const days = Math.min(14, Math.max(2, Math.ceil((now - firstAt) / DAY) + 1));
  const urls = new Set(entries.map((e) => canonicalUrl(e.url)));
  const markets = marketIds
    .map((mid) => (store.markets || []).find((m) => m.id === mid))
    .filter(Boolean)
    .slice(0, 4)
    .map((m) => {
      const outcomes = marketHistory(m, { days, now, max: 120 });
      const jumps = moved.filter((mv) => mv.market === m.id).map(({ label, start, end, from, to, change, after }) => ({ label, start, end, from, to, change, lead: after.find((a) => urls.has(canonicalUrl(a.url)))?.lead ?? null }));
      return { id: m.id, title: m.title, url: m.url, image: m.image, binary: m.binary, outcomes, move: marketMove(outcomes, firstAt), jumps };
    });

  const data = {
    sid,
    live: !!live && store.live.has(sid),
    title: base.title,
    url: base.url,
    summary: base.summary || '',
    image: base.image || null,
    topics: base.topics || [],
    entities: base.entities || [],
    firstAt,
    lastAt,
    lead: (({ summary, ...e }) => e)(timeline.find((e) => !RELAYS.has(e.platform)) || timeline[0] || {}),
    outlets: timeline.length,
    timeline: timeline.slice(0, 40).map(({ summary, ...e }) => e),
    growth: growthOf(entries),
    brief: briefOf(entries, base.summary),
    reactions: reactions.map(({ summary, ...r }) => r),
    background,
    markets,
    generatedAt: now,
  };
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(sid, { at: now, data });
  return data;
}
