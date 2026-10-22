// "For you": the live feed ranked for one reader's follows and saved stories.
//
// Follows live in the reader's browser and arrive with each request: topic
// keys, names from the Connections graph, X handles and outlets. A story
// matches a follow when it's tagged with the topic, names the name in its
// headline or summary, or carries a post or article from the account or
// outlet. Saved stories and the matched ones together make a "taste" vector
// (the mean of their embeddings, in the vectors worker), which brings in
// stories that are close in meaning but name none of the follows.
//
// The server keeps nothing: the same request gives the same feed.

import { runJob } from './offload.js';
import { loggedStory } from './stories.js';
import { topicKeys, topicLabel } from './topics.js';
import { vectorIndex } from './semantic.js';

export const LIMITS = { topics: 30, names: 30, accounts: 30, outlets: 30, saved: 60 };
const TASTE_MIN = 0.62; // below this a story is only loosely like the seeds

const list = (s, re, max) => [...new Set(String(s || '').split(',').map((x) => x.trim()).filter((x) => re.test(x)))].slice(0, max);

// Query string -> follows. Anything malformed is dropped, not an error.
export function parseFollows(params) {
  const get = (k) => (typeof params.get === 'function' ? params.get(k) : params[k]);
  const topics = new Set(topicKeys());
  return {
    topics: list(get('t'), /^[a-z0-9-]{2,40}$/, LIMITS.topics).filter((k) => topics.has(k)),
    names: list(get('n'), /^[a-z0-9-]{2,60}$/, LIMITS.names),
    accounts: list(get('a'), /^\w{1,15}$/, LIMITS.accounts),
    outlets: list(get('o'), /^[^<>"]{2,60}$/, LIMITS.outlets),
    saved: list(get('s'), /^[\w-]{6,16}$/, LIMITS.saved),
  };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Reasons a story matches the follows: [{ kind, key, label }].
export function matchFollows(story, f, { names = new Map() } = {}) {
  const why = [];
  const ents = new Set(story.entities || []);
  for (const k of f.topics) if (ents.has(k)) why.push({ kind: 'topic', key: k, label: topicLabel(k) });
  const text = `${story.title} ${story.summary || ''}`;
  for (const k of f.names) {
    const n = names.get(k);
    if (!n) continue;
    if ((n.topic && ents.has(n.topic) && !f.topics.includes(n.topic)) || n.re.test(text)) why.push({ kind: 'name', key: k, label: n.label });
  }
  if (f.accounts.length) {
    const handles = new Set(f.accounts.map((h) => h.toLowerCase()));
    const seen = new Set();
    for (const s of story.sources || []) {
      if (s.platform !== 'x') continue;
      const h = s.name.replace(/^@/, '');
      if (handles.has(h.toLowerCase()) && !seen.has(h.toLowerCase())) {
        seen.add(h.toLowerCase());
        why.push({ kind: 'account', key: h, label: `@${h}` });
      }
    }
  }
  if (f.outlets.length) {
    const outs = new Set(f.outlets.map((o) => o.toLowerCase()));
    const seen = new Set();
    for (const s of story.sources || []) {
      const o = (s.name || '').toLowerCase();
      if (s.platform === 'x' || !outs.has(o) || seen.has(o)) continue;
      seen.add(o);
      why.push({ kind: 'outlet', key: s.name, label: s.name });
    }
  }
  return why;
}

// Names (graph node keys) -> label matchers.
export function nameIndex(graph) {
  const m = new Map();
  for (const n of graph?.nodes || []) m.set(n.key, { label: n.label, topic: n.topic || null, re: new RegExp(`(?<![\\p{L}\\p{N}])${escRe(n.label)}(?![\\p{L}\\p{N}])`, 'u') });
  return m;
}

// Story -> the URLs whose embeddings stand for it (lead first).
const urlsOf = (s) => [s.url, ...(s.sources || []).filter((x) => x.platform !== 'x').map((x) => x.url)].filter(Boolean).slice(0, 4);

// ---- Worker side ----

// Similarity of each candidate to the mean of the seeds. Docs are found by
// URL; a story is as close as its closest stored article.
export function tasteScores(db, { seeds, candidates }) {
  const idx = vectorIndex(db);
  const rowFor = db.prepare('SELECT id FROM docs WHERE url = ?');
  const rows = (urls) => urls.map((u) => rowFor.get(u)?.id).map((id) => (id == null ? null : idx.rowOf(id))).filter((r) => r != null);
  const seedRows = [...new Set(seeds.flatMap((u) => rows([u])))];
  if (!seedRows.length) return { seeds: 0, scores: {} };
  const taste = idx.centroid(seedRows);
  const scores = {};
  for (const c of candidates) {
    let best = -1;
    for (const r of rows(c.urls)) best = Math.max(best, idx.score(taste, r));
    if (best > -1) scores[c.sid] = +best.toFixed(4);
  }
  return { seeds: seedRows.length, scores };
}

// ---- Server side ----

export async function forYou(store, follows, { graph = null, limit = 40, taste = (job) => runJob(job) } = {}) {
  const sn = store.snapshot;
  const stories = (sn.stories || []).filter((s) => s.sid);
  const names = nameIndex(graph);
  const hot = new Set((sn.breaking || []).map((b) => b.sid));
  const matched = new Map();
  for (const s of stories) {
    const why = matchFollows(s, follows, { names });
    if (why.length) matched.set(s.sid, why);
  }

  // Seeds: saved stories (live or logged) and the best follow matches.
  const seedUrls = [];
  const live = new Map(stories.map((s) => [s.sid, s]));
  for (const sid of follows.saved) {
    const s = live.get(sid);
    if (s) seedUrls.push(...urlsOf(s).slice(0, 2));
    else {
      const old = loggedStory(sid);
      if (old) seedUrls.push(...old.urls.filter((u) => !/^https:\/\/x\.com\//.test(u)).slice(0, 2));
    }
  }
  const byScore = [...matched.keys()].map((sid) => live.get(sid)).sort((a, b) => b.score - a.score);
  for (const s of byScore.slice(0, 20)) seedUrls.push(s.url);

  let sims = {};
  let seeds = 0;
  if (seedUrls.length) {
    try {
      const r = await taste({ kind: 'taste', seeds: seedUrls.slice(0, 80), candidates: stories.slice(0, 300).map((s) => ({ sid: s.sid, urls: urlsOf(s) })) });
      sims = r.scores;
      seeds = r.seeds;
    } catch {
      /* follows alone still rank */
    }
  }

  const saved = new Set(follows.saved);
  const ranked = [];
  for (const s of stories) {
    if (saved.has(s.sid)) continue;
    const why = matched.get(s.sid) || [];
    const sim = sims[s.sid] ?? 0;
    const like = sim >= TASTE_MIN;
    if (!why.length && !like) continue;
    const kinds = new Set(why.map((w) => `${w.kind}:${w.key}`)).size;
    const score = Math.min(6, 2 * kinds) + (like ? Math.min(4, (sim - 0.58) * 25) : 0) + Math.log1p(s.score) + (hot.has(s.sid) ? 1.5 : 0);
    if (!why.length) why.push({ kind: 'taste', key: 'taste', label: follows.saved.length ? 'Like stories you saved' : 'Like stories you follow' });
    ranked.push({ score, s, why, sim });
  }
  ranked.sort((a, b) => b.score - a.score);

  // Latest posts from followed accounts, newest first.
  const handles = new Set(follows.accounts.map((h) => h.toLowerCase()));
  const posts = handles.size
    ? (sn.social || []).filter((p) => p.platform === 'x' && handles.has(String(p.handle).toLowerCase())).slice(0, 8)
      .map((p) => ({ url: p.url, text: p.summary || p.title, author: p.author, handle: p.handle, avatar: p.avatar || null, publishedAt: p.publishedAt }))
    : [];

  return {
    version: sn.version,
    seeds,
    matched: matched.size,
    stories: ranked.slice(0, limit).map(({ s, why, sim, score }) => ({
      sid: s.sid, id: s.id, title: s.title, url: s.url, summary: s.summary, image: s.image || null, lead: s.lead, publishedAt: s.publishedAt, updatedAt: s.updatedAt,
      sources: s.sources.length, topics: s.topics, breaking: hot.has(s.sid), why: why.slice(0, 3), sim: sim ? +sim.toFixed(3) : null, score: +score.toFixed(2),
    })),
    posts,
  };
}

// What's worth following right now: trending topics, the most-mentioned
// names, active accounts and the outlets in the live feed.
export function followSuggestions(store, { graph = null, accounts = null } = {}) {
  const sn = store.snapshot;
  const topicCounts = new Map();
  const outletCounts = new Map();
  for (const s of sn.stories || []) {
    for (const e of s.entities || []) topicCounts.set(e, (topicCounts.get(e) || 0) + 1);
    for (const src of s.sources || []) if (src.platform === 'web' && src.kind === 'press') outletCounts.set(src.name, (outletCounts.get(src.name) || 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    topics: top(topicCounts, 16).filter(([k]) => topicKeys().includes(k)).map(([key, n]) => ({ key, label: topicLabel(key), n })),
    names: (graph?.nodes || []).filter((x) => !x.topic).slice(0, 16).map((x) => ({ key: x.key, label: x.label, n: x.n })),
    accounts: (accounts?.accounts || []).slice(0, 16).map((a) => ({ key: a.handle, label: a.name, handle: a.handle, avatar: a.avatar, n: a.posts, ahead: a.ahead })),
    outlets: top(outletCounts, 16).map(([key, n]) => ({ key, label: key, n })),
  };
}
