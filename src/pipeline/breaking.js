// Breaking news: a story many separate outlets pick up within the hour.
//
// Coverage velocity is counted in distinct voices over the last hour, not
// items: an outlet or press desk counts 1, a lab's own post 1.5, an X
// account 0.75 (at most four of them, so a pile-on of reposts can't trip it
// alone) and Hacker News or a subreddit 0.4 (at most two). A story breaks
// when that reaches 4 with at least two outlets or labs among it and the
// story itself is under six hours old, so a fresh round of takes on an old
// story doesn't count. It stays breaking while the pace holds and ends when
// it falls under 2 for half an hour, or six hours after it broke.
//
// Every break is recorded (table `breaking`), which gives the archive page
// its history and makes sure each story is pushed to subscribers once.

import { q } from '../db.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
export const WINDOW = HOUR;
export const START_AT = 4;
const END_AT = 2;
const COOL_OFF = 30 * MIN;
const MAX_AGE = 6 * HOUR;
const MAX_LIVE = 6 * HOUR;
const RELAYS = new Set(['hn', 'reddit']);

// A source's voice: one per outlet, X account or community.
const voiceOf = (it) => {
  if (it.platform === 'x' || it.platform === 'bluesky') return `${it.platform}:${String(it.handle || it.source || '').toLowerCase()}`;
  if (it.platform === 'reddit') return `reddit:${String(it.source || '').toLowerCase()}`;
  if (it.platform === 'hn') return 'hn';
  return `web:${String(it.source || it.host || '').toLowerCase()}`;
};

const titleKey = (t) => String(t || '').toLowerCase().replace(/\s+[-|–—]\s+[^-|–—]+$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Distinct voices on a story within `window` before `now`. Outlets running
// the same headline word for word are one syndicated story, not several
// newsrooms: copies after the first count as 0.25.
export function velocity(items, now, { window = WINDOW } = {}) {
  const seen = new Map(); // voice -> kind
  const titles = new Set();
  let copies = 0;
  for (const it of [...items].sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0))) {
    const t = it.publishedAt;
    if (!t || t > now || t < now - window) continue;
    const v = voiceOf(it);
    if (seen.has(v)) continue;
    const kind = it.platform === 'x' || it.platform === 'bluesky' ? 'x' : RELAYS.has(it.platform) ? 'community' : it.kind === 'lab' ? 'lab' : 'press';
    if (kind === 'press') {
      const k = titleKey(it.title);
      if (titles.has(k)) { seen.set(v, 'copy'); copies++; continue; }
      titles.add(k);
    }
    seen.set(v, kind);
  }
  let press = 0, lab = 0, x = 0, community = 0;
  for (const k of seen.values()) {
    if (k === 'copy') continue;
    if (k === 'press') press++;
    else if (k === 'lab') lab++;
    else if (k === 'x') x++;
    else community++;
  }
  const weight = press + copies * 0.25 + lab * 1.5 + Math.min(x, 4) * 0.75 + Math.min(community, 2) * 0.4;
  return { weight: Math.round(weight * 10) / 10, press, lab, x, community, voices: seen.size };
}

// The earliest original report (relays don't count) on a story.
function firstAt(items) {
  let t = Infinity;
  for (const it of items) if (!RELAYS.has(it.platform) && it.publishedAt && it.publishedAt < t) t = it.publishedAt;
  return t;
}

export function isBreaking(v, ageMs) {
  return v.weight >= START_AT && v.press + v.lab >= 2 && ageMs <= MAX_AGE;
}

// Distinct voices so far, every ten minutes from the first report: the
// curve the archive draws.
export function coverageCurve(items, from, to, step = 10 * MIN) {
  const firsts = new Map();
  for (const it of items) {
    if (!it.publishedAt) continue;
    const v = voiceOf(it);
    if (!firsts.has(v) || it.publishedAt < firsts.get(v)) firsts.set(v, it.publishedAt);
  }
  const times = [...firsts.values()].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  for (let t = from; t <= to + step - 1; t += step) {
    while (i < times.length && times[i] <= t) i++;
    out.push(i);
  }
  return out;
}

const lead = (s) => ({ sid: s.sid, title: s.title, url: s.url, image: s.image || null, topics: s.topics || [] });

// Watches the live stories on every rebuild. `update` returns the stories
// that just broke; `active` the ones still breaking.
export class BreakingTracker {
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.live = new Map(); // sid -> event
    this.loaded = false;
  }

  load(now) {
    if (this.loaded || !this.persist) return;
    this.loaded = true;
    // Events still running when the process stopped carry on.
    for (const r of q('SELECT * FROM breaking WHERE ended_at IS NULL AND started_at >= ?').all(now - MAX_LIVE)) {
      this.live.set(r.sid, { sid: r.sid, title: r.title, url: r.url, image: r.image, topics: JSON.parse(r.topics || '[]'), startedAt: r.started_at, firstAt: r.first_at, peak: r.peak, voices: r.voices, lastHot: now, pushed: !!r.pushed });
    }
  }

  update(stories, now = Date.now()) {
    this.load(now);
    const started = [];
    const seen = new Set();
    for (const s of stories) {
      if (!s.sid || !s._group) continue;
      const items = s._group;
      const v = velocity(items, now);
      const first = firstAt(items);
      const e = this.live.get(s.sid);
      if (e) {
        seen.add(s.sid);
        Object.assign(e, lead(s), { now: v });
        e.peak = Math.max(e.peak, v.weight);
        e.voices = Math.max(e.voices, v.voices);
        e.curve = coverageCurve(items, e.firstAt, now);
        if (v.weight >= END_AT) e.lastHot = now;
        continue;
      }
      if (!isBreaking(v, now - first)) continue;
      const ev = { ...lead(s), startedAt: now, firstAt: first, peak: v.weight, voices: v.voices, lastHot: now, now: v, pushed: false, curve: coverageCurve(items, first, now) };
      this.live.set(s.sid, ev);
      seen.add(s.sid);
      started.push(ev);
    }
    const ended = [];
    for (const [sid, e] of this.live) {
      // A story that left the feed or regrouped under another id has cooled too.
      if (!seen.has(sid)) e.lastHot = Math.min(e.lastHot, now - COOL_OFF);
      if (now - e.lastHot >= COOL_OFF || now - e.startedAt >= MAX_LIVE) {
        e.endedAt = now;
        ended.push(e);
        this.live.delete(sid);
      }
    }
    if (this.persist) this.save(started, ended);
    return started;
  }

  save(started, ended) {
    const all = [...started, ...this.live.values(), ...ended];
    if (!all.length) return;
    const up = q(`INSERT INTO breaking (sid, title, url, image, topics, first_at, started_at, ended_at, peak, voices, curve, pushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET title = excluded.title, url = excluded.url, image = COALESCE(excluded.image, image), topics = excluded.topics,
        ended_at = excluded.ended_at, peak = MAX(peak, excluded.peak), voices = MAX(voices, excluded.voices), curve = excluded.curve, pushed = MAX(pushed, excluded.pushed)`);
    for (const e of new Set(all)) {
      up.run(e.sid, e.title, e.url, e.image, JSON.stringify(e.topics), e.firstAt, e.startedAt, e.endedAt ?? null, e.peak, e.voices, JSON.stringify(e.curve || []), e.pushed ? 1 : 0);
    }
  }

  markPushed(sid) {
    const e = this.live.get(sid);
    if (e) e.pushed = true;
    if (this.persist) q('UPDATE breaking SET pushed = 1 WHERE sid = ?').run(sid);
  }

  // What the page shows: newest break first.
  active() {
    return [...this.live.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ lastHot, pushed, ...e }) => ({ ...e, now: e.now ? { weight: e.now.weight, voices: e.now.voices } : null }));
  }
}

// Past breaks, newest first, for the archive.
export function breakingHistory({ days = 7, now = Date.now(), limit = 60 } = {}) {
  return q('SELECT sid, title, url, image, topics, first_at, started_at, ended_at, peak, voices, curve FROM breaking WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?')
    .all(now - days * 86400e3, limit)
    .map((r) => ({
      sid: r.sid, title: r.title, url: r.url, image: r.image, topics: JSON.parse(r.topics || '[]'),
      firstAt: r.first_at, startedAt: r.started_at, endedAt: r.ended_at, peak: r.peak, voices: r.voices, curve: JSON.parse(r.curve || '[]'),
    }));
}
