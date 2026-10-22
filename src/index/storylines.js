// Storylines: stories that keep coming back. A lawsuit, an export ban, a
// launch and its fallout run for weeks as a string of separate days' stories;
// this strings them back together.
//
// Each day of the window is clustered the way the front page is (history
// worker; a past day is clustered once and kept). Every story with two or
// more outlets becomes a chapter with a vector, the mean of its articles'
// embeddings (vectors worker). Chapters are then read in date order and each
// joins the open storyline it is closest to — compared with that line's last
// few chapters, so a line follows its story as it moves on rather than
// drifting toward whatever its first day was about — or starts a new one.
// A storyline is a line with chapters on three or more days.

import crypto from 'node:crypto';
import { clusterItems } from '../pipeline/cluster.js';
import { tokens } from '../pipeline/text.js';
import { topicLabel } from './topics.js';
import { centralHeadline, dayItems, dayOf, outletsOf } from './day.js';
import { runJob } from './offload.js';

const DAY = 86400e3;
export const WINDOW_DAYS = 60;
const MIN_OUTLETS = 2;
const JOIN = 0.78; // cosine to a line's recent chapters to join it, with shared words
const SURE = 0.85; // ...or without
const GAP_DAYS = 8; // a line with nothing for longer is closed
const RECENT = 4; // chapters that stand for where a line is now
const MIN_DAYS = 3;

// ---- History worker: the window's stories, a day at a time ----

const dayCache = new Map(); // past day -> chapters

function chaptersOf(db, day, now) {
  const from = Date.parse(`${day}T00:00:00Z`);
  const items = dayItems(db, from, Math.min(from + DAY, now + 5 * 60e3));
  const out = [];
  for (const s of clusterItems(items)) {
    const outlets = outletsOf(s);
    if (outlets < MIN_OUTLETS) continue;
    const group = [...s._group].sort((a, b) => a.publishedAt - b.publishedAt);
    const lead = centralHeadline(group);
    out.push({
      day,
      title: lead.title,
      url: lead.url,
      source: lead.source,
      at: group[0].publishedAt,
      image: lead.image || null,
      outlets,
      entities: s.entities.slice(0, 4),
      docs: group.map((it) => Number(it.id)).slice(0, 40),
      items: group.filter((it) => it.url !== lead.url && it.platform !== 'x')
        .filter((it, i, a) => a.findIndex((x) => x.source === it.source) === i)
        .slice(0, 5)
        .map((it) => ({ title: it.title, url: it.url, source: it.source })),
    });
  }
  return out;
}

export function storyDays(db, { now = Date.now(), days = WINDOW_DAYS } = {}) {
  const today = dayOf(now);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(now - i * DAY);
    if (day === today) {
      out.push(...chaptersOf(db, day, now));
      continue;
    }
    if (!dayCache.has(day)) dayCache.set(day, chaptersOf(db, day, now));
    out.push(...dayCache.get(day));
  }
  // Days that left the window.
  const first = dayOf(now - (days - 1) * DAY);
  for (const d of dayCache.keys()) if (d < first) dayCache.delete(d);
  return { generatedAt: now, days, chapters: out };
}

// ---- Vectors worker: chapters into lines ----

const unit = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let k = 0; k < v.length; k++) v[k] /= n;
  return v;
};
const cos = (a, b) => {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
};

// `vecOf(chapter)` gives a unit vector or null; `chapters` in date order.
export function chainChapters(chapters, vecOf, { join = JOIN, sure = SURE, gapDays = GAP_DAYS } = {}) {
  // Headline words that are rare across the window: names, places, numbers.
  const df = new Map();
  const toks = new Map(chapters.map((c) => [c, new Set(tokens(c.title).filter((t) => t.length > 2 || /\d/.test(t)))]));
  for (const ts of toks.values()) for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
  const rare = (t) => df.get(t) <= Math.max(3, chapters.length * 0.03);
  const lines = [];
  for (const c of chapters) {
    const v = vecOf(c);
    if (!v) continue;
    const words = [...toks.get(c)].filter(rare);
    const t = Date.parse(`${c.day}T00:00:00Z`);
    let best = null;
    let bestScore = join;
    for (const l of lines) {
      if (t - l.lastT > gapDays * DAY) continue;
      // Some company or theme in common, when both name any.
      if (c.entities.length && l.entities.size && !c.entities.some((k) => l.entities.has(k))) continue;
      const sc = cos(v, l.recent);
      if (sc <= bestScore) continue;
      // Close in meaning alone is often just the same company's other news;
      // below `sure`, a chapter also has to share a rare headline word
      // with the line’s recent chapters (the defendant’s name, the deal size).
      if (sc < sure && !words.some((w) => l.words.has(w))) continue;
      [best, bestScore] = [l, sc];
    }
    if (!best) {
      best = { chapters: [], vecs: [], entities: new Set(), words: new Set(), said: [], lastT: t, recent: null };
      lines.push(best);
    }
    best.chapters.push({ ...c, score: best.chapters.length ? +bestScore.toFixed(3) : null });
    best.vecs.push(v);
    for (const k of c.entities) best.entities.add(k);
    best.lastT = Math.max(best.lastT, t);
    const r = new Float32Array(v.length);
    for (const x of best.vecs.slice(-RECENT)) for (let k = 0; k < r.length; k++) r[k] += x[k];
    best.recent = unit(r);
    best.said.push(words);
    best.words = new Set(best.said.slice(-RECENT * 2).flat());
  }
  return lines;
}

const idOf = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);

// Lines into storylines: named, counted and ranked, newest activity first.
export function shapeStorylines(lines, { now = Date.now(), days = WINDOW_DAYS, minDays = MIN_DAYS } = {}) {
  const today = dayOf(now);
  const first = dayOf(now - (days - 1) * DAY);
  const out = [];
  for (const l of lines) {
    const byDay = new Map();
    for (const c of l.chapters) byDay.set(c.day, (byDay.get(c.day) || 0) + c.outlets);
    if (byDay.size < minDays) continue;
    const chapters = [...l.chapters].sort((a, b) => a.at - b.at);
    const biggest = [...chapters].sort((a, b) => b.outlets - a.outlets || a.at - b.at)[0];
    const last = chapters[chapters.length - 1];
    const ents = new Map();
    for (const c of chapters) for (const k of c.entities) ents.set(k, (ents.get(k) || 0) + 1);
    const age = (c) => (now - Date.parse(`${c.day}T12:00:00Z`)) / DAY;
    // Coverage, with each chapter counting for less as it ages (a week's half-life).
    const heat = chapters.reduce((n, c) => n + c.outlets * 0.5 ** (Math.max(0, age(c)) / 7), 0);
    const daysAgo = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last.day}T00:00:00Z`)) / DAY));
    out.push({
      id: idOf(chapters[0].url),
      title: biggest.title,
      url: biggest.url,
      image: biggest.image || chapters.find((c) => c.image)?.image || null,
      latest: { title: last.title, url: last.url, source: last.source, day: last.day, at: last.at },
      from: chapters[0].day,
      to: last.day,
      active: daysAgo <= 1,
      daysAgo,
      dayCount: byDay.size,
      chapterCount: chapters.length,
      outlets: chapters.reduce((n, c) => n + c.outlets, 0),
      heat: +heat.toFixed(2),
      entities: [...ents].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key]) => ({ key, label: topicLabel(key) })),
      daily: [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, n]) => ({ day, n })),
      chapters: chapters.map(({ docs, entities, ...c }) => ({ ...c, entities: entities.map((key) => ({ key, label: topicLabel(key) })) })),
    });
  }
  out.sort((a, b) => b.heat - a.heat);
  return { generatedAt: now, from: first, to: today, days, total: out.length, storylines: out };
}

export function computeStorylines(index, { chapters, now = Date.now(), days = WINDOW_DAYS }) {
  const vecOf = (c) => {
    const rows = c.docs.map((id) => index.rowOf(id)).filter((r) => r != null);
    return rows.length ? index.centroid(rows) : null;
  };
  const sorted = [...chapters].sort((a, b) => a.at - b.at);
  return shapeStorylines(chainChapters(sorted, vecOf), { now, days });
}

// ---- Server side ----

const TTL = 30 * 60e3;
let memo = { at: 0, data: null, pending: null };

// The window's chapters from the history worker, chained in the vectors
// worker (which holds the embeddings); the list and every storyline page
// come from one result.
export function storylinesData() {
  if (memo.data && Date.now() - memo.at < TTL) return Promise.resolve(memo.data);
  memo.pending ||= runJob({ kind: 'storyDays' })
    .then(({ chapters }) => runJob({ kind: 'storylines', chapters }))
    .then((data) => {
      memo = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch((err) => {
      memo.pending = null;
      throw err;
    });
  return memo.data ? Promise.resolve(memo.data) : memo.pending;
}

// The list leaves out chapter detail; a storyline page has all of it.
export const storylineList = (d, { limit = 40 } = {}) => ({
  ...d,
  storylines: d.storylines.slice(0, limit).map(({ chapters, ...s }) => ({ ...s, top: chapters.filter((c) => c.outlets >= 3).slice(-3).map((c) => ({ day: c.day, title: c.title, url: c.url, outlets: c.outlets })) })),
});

export const storylineById = (d, id) => d.storylines.find((s) => s.id === id) || null;

// The storyline a story is part of: one of its links or its headline is a
// chapter or one of a chapter's reports.
export function storylineOf(d, { url, title, timeline = [] }) {
  const urls = new Set([url, ...timeline.map((e) => e.url)].filter(Boolean));
  for (const s of d.storylines) {
    if (s.chapters.some((c) => urls.has(c.url) || c.title === title || c.items.some((i) => urls.has(i.url)))) {
      return { id: s.id, title: s.title, dayCount: s.dayCount, chapterCount: s.chapterCount, from: s.from, to: s.to, active: s.active };
    }
  }
  return null;
}
