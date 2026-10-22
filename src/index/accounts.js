// X account pages: what one account posts about, when, and how often it is
// ahead of the press.
//
// Every X post we've stored (docs with site 'x.com') carries its handle in
// meta and has an embedding. "Ahead of the press" compares each post with the
// articles published from six hours before it to a day after: when articles
// that say the same thing (cosine >= AHEAD) only appear after the post, and
// none did before, the post led the news by the time to the first of them.
// Linked posts lead too, unless the article they link to came out first.
//
// Runs in the vectors worker (offload.js), which holds every vector in memory.

import { extractEntities, topicsFor } from '../pipeline/classify.js';
import { ENTITY_LABELS } from '../pipeline/trending.js';
import { X_ACCOUNTS } from '../config.js';
import { cachedJob } from './offload.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const AHEAD = 0.8; // bge-small: same event, different words
const BEFORE = 6 * HOUR;
const AFTER = DAY;
const MIN_LEAD = 10 * 60e3;

const GROUP_OF = new Map(X_ACCOUNTS.map((a) => [a.handle.toLowerCase(), a.group]));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

function loadPosts(db, since, handle = null) {
  const rows = db.prepare(`SELECT id, url, title, description, author, image_url, published_at AS at, engagement, meta FROM docs
    WHERE site = 'x.com' AND type = 'post' AND hidden = 0 AND published_at >= ? ORDER BY published_at`).all(since);
  const out = [];
  for (const r of rows) {
    const m = parse(r.meta);
    if (!m.handle || (handle && m.handle.toLowerCase() !== handle)) continue;
    out.push({ id: r.id, url: r.url, text: r.description || r.title, author: r.author, handle: m.handle, avatar: m.avatar || null, linkUrl: m.linkUrl || null, image: r.image_url || null, at: r.at, engagement: r.engagement || 0 });
  }
  return out;
}

// The newest posts from one account (for its feed).
export function recentPosts(db, handle, { days = 14, limit = 40, now = Date.now() } = {}) {
  return loadPosts(db, now - days * 86400e3, handle.toLowerCase()).slice(-limit).reverse();
}

// Articles in the window, oldest first: ids, times and vector rows only.
// Reddit and Hacker News relay links, so they don't count as the press.
const RELAY_SITES = new Set(['reddit.com', 'news.ycombinator.com', 'x.com']);
function loadArticles(db, idx, from, to) {
  const rows = db.prepare(`SELECT id, site, published_at AS at FROM docs
    WHERE type = 'article' AND hidden = 0 AND published_at >= ? AND published_at <= ? ORDER BY published_at`).all(from, to);
  const out = [];
  for (const r of rows) {
    const row = idx.rowOf(r.id);
    if (row != null && !RELAY_SITES.has(r.site)) out.push({ id: r.id, at: r.at, row });
  }
  return out;
}

const lowerBound = (arr, t) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].at < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// Did articles saying the same thing only come after the post? Returns
// { leadMin, firstId, followers } or null. `info(id)` gives an article's url
// (to tell a post's own link from coverage) and source.
export function aheadOf(post, articles, idx, info, { threshold = AHEAD } = {}) {
  const row = idx.rowOf(post.id);
  if (row == null) return null;
  const linked = post.linkUrl ? post.linkUrl.replace(/[?#].*$/, '') : null;
  let first = null;
  const outlets = new Set();
  for (let i = lowerBound(articles, post.at - BEFORE); i < articles.length && articles[i].at <= post.at + AFTER; i++) {
    const a = articles[i];
    if (idx.dot(row, a.row) < threshold) continue;
    const { url, source } = info(a.id);
    // A link to the article itself isn't coverage of the post.
    if (linked && url.startsWith(linked)) continue;
    // Covered already, or within minutes: not a lead.
    if (a.at < post.at + MIN_LEAD) return null;
    first ||= a;
    outlets.add(source);
  }
  if (!first) return null;
  const leadMin = Math.round((first.at - post.at) / 60e3);
  // One late follow-up is a coincidence more often than a lead.
  if (outlets.size < 2 && leadMin > 6 * 60) return null;
  return { leadMin, firstId: first.id, followers: outlets.size };
}

// Stories the post joined in the live feed.
function storiesOf(db, urls) {
  if (!urls.length) return new Map();
  const out = new Map();
  for (let i = 0; i < urls.length; i += 400) {
    const chunk = urls.slice(i, i + 400);
    for (const r of db.prepare(`SELECT si.item_url, sl.sid, sl.title, sl.sources, sl.first_at FROM story_ids si JOIN story_log sl ON sl.sid = si.sid
      WHERE si.item_url IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) out.set(r.item_url, { sid: r.sid, title: r.title, sources: r.sources, firstAt: r.first_at });
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Ahead-of-the-press results for posts more than a day old are final.
const settled = new Map(); // post url -> ahead result (or null)

// Shared by the directory and the account page: per-post signals.
function annotate(db, idx, posts, now) {
  if (!posts.length) return posts;
  const open = posts.filter((p) => !settled.has(p.url));
  if (open.length) {
    const articles = loadArticles(db, idx, open[0].at - BEFORE, Math.min(now, open.at(-1).at + AFTER));
    const getInfo = db.prepare('SELECT url, COALESCE(source, site) AS source FROM docs WHERE id = ?');
    const infos = new Map();
    const info = (id) => infos.get(id) || infos.set(id, getInfo.get(id)).get(id);
    for (const p of open) {
      const r = aheadOf(p, articles, idx, info);
      if (now - p.at > AFTER) settled.set(p.url, r);
      p.ahead = r;
    }
  }
  const firsts = new Map();
  const getFirst = db.prepare('SELECT title, url, COALESCE(source, site) AS source, published_at AS at FROM docs WHERE id = ?');
  const stories = storiesOf(db, posts.map((p) => p.url));
  for (const p of posts) {
    if (!('ahead' in p)) p.ahead = settled.get(p.url);
    if (p.ahead && !p.ahead.first) {
      const f = firsts.get(p.ahead.firstId) || getFirst.get(p.ahead.firstId);
      firsts.set(p.ahead.firstId, f);
      p.ahead = { leadMin: p.ahead.leadMin, followers: p.ahead.followers, first: f ? { ...f } : null };
    }
    p.story = stories.get(p.url) || null;
    // "Best": led the news, was picked up widely, or both.
    p.score = (p.ahead ? 2 + Math.log2(1 + p.ahead.followers) + Math.min(2, p.ahead.leadMin / 120) : 0) + (p.story ? Math.log2(1 + p.story.sources) : 0) + Math.log10(1 + p.engagement);
  }
  return posts;
}

function cadence(posts, since, days) {
  const daily = new Map();
  for (let i = 0; i < days; i++) daily.set(dayOf(since + i * DAY), 0);
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0)); // [weekday Mon=0][UTC hour]
  for (const p of posts) {
    const d = dayOf(p.at);
    if (daily.has(d)) daily.set(d, daily.get(d) + 1);
    const dt = new Date(p.at);
    grid[(dt.getUTCDay() + 6) % 7][dt.getUTCHours()]++;
  }
  return { daily: [...daily].map(([day, n]) => ({ day, n })), grid };
}

function topicsOf(posts) {
  const ents = new Map();
  const themes = new Map();
  for (const p of posts) {
    for (const [k, strong] of extractEntities(p.text)) if (strong) ents.set(k, (ents.get(k) || 0) + 1);
    for (const t of topicsFor(p.text)) themes.set(t, (themes.get(t) || 0) + 1);
  }
  const top = (m, n, label) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, label: label(key), count, share: +(count / posts.length).toFixed(3) }));
  return { entities: top(ents, 8, (k) => ENTITY_LABELS[k] || k), themes: top(themes, 6, (k) => k) };
}

function mentionsOf(posts, self) {
  const m = new Map();
  for (const p of posts) for (const [, h] of p.text.matchAll(/@(\w{2,15})/g)) {
    if (h.toLowerCase() === self) continue;
    m.set(h, (m.get(h) || 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([handle, n]) => ({ handle, n }));
}

const shapePost = (p) => ({ url: p.url, text: p.text, at: p.at, image: p.image, linkUrl: p.linkUrl, ahead: p.ahead, story: p.story ? { sid: p.story.sid, title: p.story.title, sources: p.story.sources } : null });

// One account in full.
export function computeAccount(db, idx, handle, { now = Date.now(), days = 30 } = {}) {
  const key = String(handle || '').toLowerCase();
  const since = new Date(dayOf(now - (days - 1) * DAY)).getTime();
  const posts = annotate(db, idx, loadPosts(db, since, key), now);
  if (!posts.length) return null;
  const last = posts.at(-1);
  const gaps = posts.slice(1).map((p, i) => p.at - posts[i].at);
  const ahead = posts.filter((p) => p.ahead);
  const { daily, grid } = cadence(posts, since, days);
  let peak = [0, 0, 0];
  grid.forEach((row, d) => row.forEach((n, h) => { if (n > peak[0]) peak = [n, d, h]; }));
  return {
    handle: last.handle,
    name: last.author || last.handle,
    avatar: last.avatar,
    group: GROUP_OF.get(key) || 'people',
    days,
    stats: {
      posts: posts.length,
      perDay: +(posts.length / days).toFixed(1),
      activeDays: daily.filter((d) => d.n).length,
      medianGapMin: gaps.length ? Math.round(median(gaps) / 60e3) : null,
      peak: peak[0] ? { weekday: peak[1], hour: peak[2] } : null,
      withLinks: posts.filter((p) => p.linkUrl).length,
      ahead: ahead.length,
      medianLeadMin: median(ahead.map((p) => p.ahead.leadMin)),
      inStories: posts.filter((p) => p.story).length,
      lastAt: last.at,
    },
    daily,
    grid,
    ...topicsOf(posts),
    mentions: mentionsOf(posts, key),
    ahead: ahead.sort((a, b) => b.ahead.followers - a.ahead.followers || b.ahead.leadMin - a.ahead.leadMin).slice(0, 8).map(shapePost),
    best: [...posts].sort((a, b) => b.score - a.score).filter((p) => p.score > 0).slice(0, 6).map(shapePost),
    recent: posts.slice(-12).reverse().map(shapePost),
    generatedAt: now,
  };
}

// Every account at a glance, for the directory and the compare picker.
export function computeAccounts(db, idx, { now = Date.now(), days = 30 } = {}) {
  const since = new Date(dayOf(now - (days - 1) * DAY)).getTime();
  const posts = annotate(db, idx, loadPosts(db, since), now);
  const by = new Map();
  for (const p of posts) {
    const k = p.handle.toLowerCase();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p);
  }
  const spark = (ps) => {
    const out = new Array(14).fill(0);
    for (const p of ps) {
      const i = 13 - Math.floor((now - p.at) / DAY);
      if (i >= 0 && i < 14) out[i]++;
    }
    return out;
  };
  const accounts = [...by].map(([k, ps]) => {
    const last = ps.at(-1);
    const ahead = ps.filter((p) => p.ahead);
    return {
      handle: last.handle,
      name: last.author || last.handle,
      avatar: last.avatar,
      group: GROUP_OF.get(k) || 'people',
      posts: ps.length,
      ahead: ahead.length,
      aheadRate: +(ahead.length / ps.length).toFixed(3),
      medianLeadMin: median(ahead.map((p) => p.ahead.leadMin)),
      inStories: ps.filter((p) => p.story).length,
      lastAt: last.at,
      spark: spark(ps),
      top: topicsOf(ps).entities.slice(0, 3).map((e) => e.label),
    };
  }).filter((a) => GROUP_OF.has(a.handle.toLowerCase()) || a.posts >= 3); // not one-off quoted accounts
  accounts.sort((a, b) => b.ahead - a.ahead || b.posts - a.posts);
  return { days, accounts, generatedAt: now };
}

// Two accounts side by side, plus where they overlap.
export function compareAccounts(db, idx, a, b, opts = {}) {
  const A = computeAccount(db, idx, a, opts);
  const B = computeAccount(db, idx, b, opts);
  if (!A || !B) return null;
  const shared = A.entities.filter((e) => B.entities.some((f) => f.key === e.key)).map((e) => ({ key: e.key, label: e.label, a: e.count, b: B.entities.find((f) => f.key === e.key).count }));
  return { a: A, b: B, shared };
}

// ---- Server side: cached in the vectors worker ----

const TTL_MS = 10 * 60e3;
export const KNOWN = new Set(X_ACCOUNTS.map((a) => a.handle.toLowerCase()));
export const accountsDirectory = () => cachedJob('accounts', { kind: 'accounts' }, TTL_MS);
export const accountProfile = (handle) => cachedJob(`account:${handle.toLowerCase()}`, { kind: 'account', handle }, TTL_MS);
export const accountCompare = (a, b) => cachedJob(`compare:${a.toLowerCase()}:${b.toLowerCase()}`, { kind: 'compare', a, b }, TTL_MS);
