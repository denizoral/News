// Catch-up: everything since a reader's last visit, in one page. The
// stories that broke or kept going while they were away (clustered from the
// window the way the front page is, ranked by outlets), the X posts people
// engaged with most, the names suddenly everywhere, the deals, and — added on
// the main thread from what's already in memory — the breaking alerts,
// market moves with the news behind them, new releases and storylines that
// gained a chapter.
//
// The window is clamped to an hour..a week and snapped to 15 minutes so
// readers arriving around the same time share one cached answer. A week is
// ~9k items, ~0.6 s in the history worker.

import { clusterItems } from '../pipeline/cluster.js';
import { isAiRelated } from '../pipeline/classify.js';
import { topicLabel } from './topics.js';
import { centralHeadline, dayItems, entityShares, outletsOf, standouts } from './day.js';
import { dealMentions, groupDeals } from './deals.js';
import { cachedJob } from './offload.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const MIN_SPAN = HOUR;
export const MAX_SPAN = 7 * DAY;
const SNAP = 15 * 60e3;
const EN = "(d.lang IS NULL OR d.lang = '' OR d.lang LIKE 'en%')";
const NOT_COVERAGE = "d.site NOT IN ('huggingface.co', 'github.com', 'openrouter.ai')";

// A requested start as a window the cache can share.
export function windowOf(since, now = Date.now()) {
  const s = Number(since);
  const from = Number.isFinite(s) && s > 0 ? Math.max(now - MAX_SPAN, Math.min(now - MIN_SPAN, s)) : now - DAY;
  // Longer windows snap to the hour: more readers share each answer.
  const snap = now - from > DAY ? HOUR : SNAP;
  return { since: Math.floor(from / snap) * snap, now };
}

// Buckets that keep the chart readable: hours for a day or so, then wider.
export const bucketOf = (span) => (span <= 36 * HOUR ? HOUR : span <= 4 * DAY ? 3 * HOUR : 6 * HOUR);

export function activity(items, since, now) {
  const size = bucketOf(now - since);
  const start = Math.floor(since / size) * size;
  const n = Math.ceil((now - start) / size);
  const out = Array.from({ length: n }, (_, i) => ({ t: start + i * size, articles: 0, posts: 0 }));
  for (const it of items) {
    const i = Math.floor((it.publishedAt - start) / size);
    if (i < 0 || i >= n) continue;
    out[i][it.platform === 'x' ? 'posts' : 'articles']++;
  }
  return { bucket: size, points: out };
}

export function computeCatchup(db, { since, now = Date.now() }) {
  const items = dayItems(db, since, now + 5 * 60e3);
  const sidOf = db.prepare('SELECT sid FROM story_ids WHERE item_url = ?');
  const firstOf = db.prepare('SELECT first_at FROM story_log WHERE sid = ?');
  const ranked = clusterItems(items)
    .map((s) => ({ s, outlets: outletsOf(s), voices: new Set(s.sources.map((x) => x.name)).size }))
    .filter((x) => x.s._group.some((it) => it.type === 'article'))
    .sort((a, b) => b.outlets - a.outlets || b.voices - a.voices || b.s.publishedAt - a.s.publishedAt);
  const stories = ranked.slice(0, 12).map(({ s, outlets, voices }) => {
    const group = [...s._group].sort((a, b) => a.publishedAt - b.publishedAt);
    const lead = centralHeadline(group);
    // The story's page, if the live feed carried it: the id most of its links have.
    const votes = new Map();
    for (const it of group) {
      const sid = sidOf.get(it.url)?.sid;
      if (sid) votes.set(sid, (votes.get(sid) || 0) + 1);
    }
    const sid = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const began = sid ? firstOf.get(sid)?.first_at : null;
    return {
      title: lead.title,
      url: lead.url,
      source: lead.source,
      image: lead.image || null,
      summary: (lead.summary || '').slice(0, 240),
      sid,
      at: group[0].publishedAt,
      last: group[group.length - 1].publishedAt,
      // Already running before the window opened: it kept going, it didn't break.
      continuing: !!began && began < since - HOUR,
      outlets,
      voices,
      posts: group.filter((it) => it.platform === 'x').length,
      entities: s.entities.slice(0, 3).map((k) => ({ key: k, label: topicLabel(k) })),
      // When its coverage landed, for a strip under the headline.
      times: group.map((it) => it.publishedAt),
      sources: [...new Set(group.filter((it) => it.platform !== 'x' && it.url !== lead.url).map((it) => it.source))].slice(0, 4),
    };
  });

  // X posts: the most engaged-with, then those inside the biggest stories
  // (likes aren't known for every account).
  const reach = new Map();
  for (const { s, outlets } of ranked) for (const it of s._group) if (it.platform === 'x') reach.set(it.url, outlets);
  const posts = items.filter((it) => it.platform === 'x')
    .sort((a, b) => b.engagement.score - a.engagement.score || (reach.get(b.url) || 0) - (reach.get(a.url) || 0) || b.publishedAt - a.publishedAt)
    .slice(0, 4)
    .map((it) => ({ text: it.title.slice(0, 280), url: it.url, handle: it.handle, author: it.author, avatar: it.avatar || null, at: it.publishedAt, score: it.engagement.score, outlets: reach.get(it.url) || 0 }));

  const deals = groupDeals(dealMentions(db, { since, until: now }))
    .sort((a, b) => (b.amount || b.valuation || 0) - (a.amount || a.valuation || 0))
    .slice(0, 5)
    .map((d) => ({ kind: d.kind, company: d.company, companyKey: d.companyKey, acquirer: d.acquirer || null, amount: d.amount || null, valuation: d.valuation || null, round: d.round || null, url: d.first.url, site: d.first.site, outlets: d.outlets }));

  // Names in the window against the four weeks before it.
  const before = db.prepare(`SELECT d.title, substr(d.description, 1, 300) AS description FROM docs d
    WHERE d.published_at >= ? AND d.published_at < ? AND d.hidden = 0 AND d.type = 'article' AND ${EN} AND ${NOT_COVERAGE}`).all(since - 28 * DAY, since)
    .filter((r) => isAiRelated(`${r.title} ${r.description}`));
  const names = standouts(entityShares(items.filter((it) => it.type === 'article').map((it) => ({ title: it.title, description: it.summary }))), entityShares(before), { min: 3, limit: 8 });

  const arts = items.filter((it) => it.platform !== 'x');
  return {
    since,
    generatedAt: now,
    totals: {
      articles: arts.length,
      posts: items.length - arts.length,
      stories: ranked.length,
      outlets: new Set(arts.map((it) => it.source)).size,
    },
    activity: activity(items, since, now),
    stories,
    posts,
    deals,
    names,
  };
}

// ---- Server side ----

export const catchupQuery = (since) => cachedJob(`catchup:${since}`, { kind: 'catchup', since }, 5 * 60e3);

// What the main thread already holds, cut to the window.
export function withLive(d, { breaking = [], moves = null, releases = [], storylines = null } = {}) {
  const since = d.since;
  const out = { ...d };
  out.breaking = breaking.filter((b) => b.startedAt >= since).slice(0, 6)
    .map((b) => ({ sid: b.sid, title: b.title, url: b.url, startedAt: b.startedAt, endedAt: b.endedAt, voices: b.voices }));
  out.moves = (moves?.moves || []).filter((m) => m.explained && m.end >= since)
    .filter((m, i, a) => a.findIndex((x) => x.market === m.market) === i)
    .slice(0, 4)
    .map((m) => ({ market: m.market, title: m.title, url: m.url, label: m.label, binary: m.binary, from: m.from, to: m.to, end: m.end, path: m.path, after: m.after[0] ? { title: m.after[0].title, url: m.after[0].url, sid: m.after[0].sid || null, source: m.after[0].source || m.after[0].site } : null }));
  out.releases = releases.filter((r) => r.date && r.date >= since).slice(0, 8)
    .map((r) => ({ id: r.id, name: r.name, provider: r.provider, url: r.url, open: !!r.open, date: r.date }));
  // Storylines with a chapter in the window: the story moved on.
  out.storylines = (storylines?.storylines || [])
    .map((s) => ({ s, fresh: s.chapters.filter((c) => c.at >= since) }))
    .filter(({ s, fresh }) => fresh.length && s.chapters.length > fresh.length)
    .slice(0, 5)
    .map(({ s, fresh }) => ({ id: s.id, title: s.title, dayCount: s.dayCount, from: s.from, latest: { title: fresh[fresh.length - 1].title, url: fresh[fresh.length - 1].url, source: fresh[fresh.length - 1].source }, fresh: fresh.length }));
  out.totals = { ...d.totals, breaking: out.breaking.length, moves: out.moves.length, releases: out.releases.length };
  return out;
}
