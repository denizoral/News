// Emerging themes: groups of live stories about the same thing whose
// coverage is accelerating, so a new subject shows up before it has a
// topic page (Claude Duet launching, an AI-found PHP bug, a merger rumour).
//
// Each live story is represented by the mean embedding of its stored items
// (story_ids -> docs -> doc_vecs). Stories are grouped greedily, biggest
// first: a story joins a theme only if it's close to both the theme's centre
// and the story that started it, which stops one broad theme ("AI news")
// swallowing everything. A theme is named by the phrase its headlines share
// that the rest of the feed doesn't, and ranked by recent coverage times its
// growth against the day and a half before.
//
// ~400 stories take ~100 ms; it runs in the history worker, cached.

import { canonicalUrl, tokens } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DIM = 384;
const HOUR = 3600e3;
const JOIN = 0.8;
const TTL_MS = 10 * 60e3;
const RECENT_H = 12;
const PRIOR_H = 36;
const SPARK_H = 48;

function storyVector(rows) {
  const acc = new Float32Array(DIM);
  for (const { v } of rows) {
    const sc = new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
    for (let i = 0; i < DIM; i++) acc[i] += ((v[4 + i] << 24) >> 24) * sc;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += acc[i] * acc[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) acc[i] /= n;
  return acc;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
};

// Greedy grouping. items: [{ v, weight }] in priority order.
export function groupVectors(items, { join = JOIN } = {}) {
  const groups = [];
  for (const it of items) {
    let best = null;
    let bestScore = join;
    for (const g of groups) {
      const s = Math.min(dot(g.centre, it.v), dot(g.seed, it.v) + 0.05);
      if (s > bestScore) [best, bestScore] = [g, s];
    }
    if (!best) {
      groups.push({ seed: it.v, sum: Float32Array.from(it.v), centre: Float32Array.from(it.v), members: [it] });
      continue;
    }
    best.members.push(it);
    let n = 0;
    for (let i = 0; i < DIM; i++) {
      best.sum[i] += it.v[i];
      n += best.sum[i] * best.sum[i];
    }
    n = Math.sqrt(n);
    for (let i = 0; i < DIM; i++) best.centre[i] = best.sum[i] / n;
  }
  return groups;
}

const STOP = new Set(['says', 'said', 'new', 'just', 'now', 'will', 'can', 'its', 'with', 'from', 'that', 'this', 'about', 'after', 'over', 'into', 'more', 'your', 'how', 'why', 'what', 'who', 'are', 'has', 'have', 'the', 'and', 'for', 'you', 'not', 'but', 'out', 'all', 'get', 'got', 'one', 'use', 'using', 'used', 'ai', 'breaking', 'report', 'reports', 'update', 'week', 'today', 'first', 'due', 'amid', 'via', 'per', 'gets', 'set', 'like', 'make', 'makes', 'made', 'way', 'big', 'time', 'year', 'next', 'still', 'than', 'may', 'could', 'would']);

// The phrase a theme's headlines share that the rest of the feed doesn't:
// bigrams beat single words, names ("Claude Duet") beat common words, and
// phrases in more of the headlines beat rarer ones. Returns up to two, best
// first, in the headlines' own capitalisation.
export function themeName(titles, allTitles) {
  const words = (t) => tokens(t).filter((x) => (x.length > 2 || /\d/.test(x)) && !STOP.has(x));
  const grams = (t) => {
    const w = words(t);
    return new Set([...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)]);
  };
  const df = new Map();
  for (const t of allTitles) for (const g of grams(t)) df.set(g, (df.get(g) || 0) + 1);
  const tf = new Map();
  for (const t of titles) for (const g of grams(t)) tf.set(g, (tf.get(g) || 0) + 1);
  const cased = (g) => {
    const re = new RegExp(`\\b${g.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-]+')}\\b`, 'i');
    for (const t of titles) {
      const m = t.match(re);
      if (m && /[A-Z]/.test(m[0])) return m[0];
    }
    return null; // only ever lowercase: a common word, not a name
  };
  const N = allTitles.length;
  const shared = Math.min(2, titles.length);
  const scored = [...tf]
    .map(([g, n]) => {
      const name = cased(g);
      const s = (n / titles.length) * Math.log(1 + N / (df.get(g) || 1)) * (g.includes(' ') ? 1.6 : 1) * (name ? 1.8 : 1) * (n >= shared ? 1 : 0.25);
      return { g, name: name || g, s };
    })
    .sort((a, b) => b.s - a.s);
  const picked = [];
  for (const { g, name } of scored) {
    if (picked.length >= 2) break;
    if (picked.some((p) => p.g.split(' ').some((w) => g.split(' ').includes(w)))) continue;
    picked.push({ g, name });
  }
  return picked.map((p) => p.name);
}

// stories: [{ sid, title, url, source, sources: [names], publishedAt, entities }]
export function computeEmerging(db, stories, { now = Date.now(), limit = 8 } = {}) {
  const urlsOf = db.prepare('SELECT item_url FROM story_ids WHERE sid = ?');
  const vecOf = db.prepare('SELECT v.v, d.published_at AS at FROM docs d JOIN doc_vecs v ON v.doc_id = d.id WHERE d.url = ?');
  const items = [];
  for (const s of stories) {
    const rows = [];
    for (const { item_url } of urlsOf.all(s.sid)) {
      const r = vecOf.get(canonicalUrl(item_url));
      if (r) rows.push(r);
    }
    if (!rows.length) continue;
    items.push({ s, v: storyVector(rows), times: rows.map((r) => r.at).filter(Boolean) });
  }
  items.sort((a, b) => b.s.sources.length - a.s.sources.length || b.times.length - a.times.length);
  const allTitles = stories.map((s) => s.title);
  const themes = [];
  for (const g of groupVectors(items)) {
    if (g.members.length < 3) continue;
    const times = g.members.flatMap((m) => m.times);
    const outlets = new Set(g.members.flatMap((m) => m.s.sources));
    const recent = times.filter((t) => t > now - RECENT_H * HOUR && t <= now + 5 * 60e3).length;
    const prior = times.filter((t) => t <= now - RECENT_H * HOUR && t > now - (RECENT_H + PRIOR_H) * HOUR).length;
    if (outlets.size < 3 || recent < 3) continue;
    // Rate in the last 12 hours against the 36 before, both per hour.
    const growth = +((recent / RECENT_H) / Math.max(1 / PRIOR_H, prior / PRIOR_H)).toFixed(1);
    const spark = new Array(SPARK_H).fill(0);
    for (const t of times) {
      const h = Math.floor((now - t) / HOUR);
      if (h >= 0 && h < SPARK_H) spark[SPARK_H - 1 - h]++;
    }
    const members = g.members.map((m) => m.s).sort((a, b) => b.sources.length - a.sources.length || b.publishedAt - a.publishedAt);
    const entities = new Map();
    for (const s of members) for (const e of s.entities || []) entities.set(e, (entities.get(e) || 0) + 1);
    themes.push({
      id: members[0].sid,
      name: themeName(members.map((s) => s.title), allTitles),
      headline: members[0].title,
      n: members.length,
      outlets: outlets.size,
      items: times.length,
      recent,
      prior,
      growth,
      isNew: prior <= 1, // next to nothing before the last 12 hours
      momentum: +(recent * Math.sqrt(Math.min(growth, 12))).toFixed(2),
      entities: [...entities].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= Math.max(2, members.length / 3)).map(([k]) => k).slice(0, 3),
      spark,
      stories: members.slice(0, 24).map(({ sid, title, url, source, sources, publishedAt }) => ({ sid, title, url, source, sources: sources.length, publishedAt })),
    });
  }
  themes.sort((a, b) => b.momentum - a.momentum);
  return { generatedAt: now, window: { recentH: RECENT_H, priorH: PRIOR_H }, themes: themes.slice(0, limit) };
}

export function emergingThemes(store) {
  const stories = (store.snapshot.stories || []).filter((s) => s.sid).map((s) => ({
    sid: s.sid,
    title: s.title,
    url: s.url,
    source: s.lead?.source,
    sources: [...new Set(s.sources.map((x) => x.name))],
    publishedAt: s.publishedAt,
    entities: s.entities,
  }));
  return cachedJob('emerging', { kind: 'emerging', stories }, TTL_MS);
}
