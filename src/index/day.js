// Any day: the front page as it would have looked on a past date, rebuilt
// from the permanent index, and a calendar of how much was published each day.
//
// A day's English AI articles and posts (spidered pages as well as feed
// items, since older days have few feed items) are clustered into stories
// the same way the front page does, and ranked by how many outlets ran them.
// Around them: the most-liked X posts, the deals announced, the companies and
// themes named far more than in the four weeks before, and the markets that
// moved most that day (odds history starts mid-October 2026).
//
// A past day doesn't change, so it's cached for hours; today for minutes.
// ~2k items cluster in ~150 ms; it runs in the history worker.

import { clusterItems } from '../pipeline/cluster.js';
import { extractEntities, isAiRelated } from '../pipeline/classify.js';
import { splitOutlet, tokens } from '../pipeline/text.js';
import { topicLabel } from './topics.js';
import { dealMentions, groupDeals } from './deals.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const EN = "(d.lang IS NULL OR d.lang = '' OR d.lang LIKE 'en%')";
const NOT_COVERAGE = "d.site NOT IN ('huggingface.co', 'github.com', 'openrouter.ai')";

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && dayOf(Date.parse(`${s}T00:00:00Z`) || 0) === s;

// Articles and posts per day (UTC) over the last `days`, and the earliest day
// the index has anything for.
export function dayCalendar(db, { now = Date.now(), days = 371 } = {}) {
  const end = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) + DAY;
  const since = end - days * DAY;
  const rows = db.prepare(`SELECT date(d.published_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM docs d
    WHERE d.published_at >= ? AND d.published_at < ? AND d.hidden = 0 AND d.type IN ('article', 'post') GROUP BY day`).all(since, end);
  const counts = new Map(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let t = since; t < end; t += DAY) out.push({ day: dayOf(t), n: counts.get(dayOf(t)) || 0 });
  return { from: dayOf(since), to: dayOf(end - DAY), days: out };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function cleanTitle(title, source, site) {
  const { title: t, outlet } = splitOutlet(title);
  const o = outlet && norm(outlet);
  return o && (o === norm(source) || norm(site).includes(o)) ? t : title;
}

// The day's items in the shape clusterItems() takes.
function dayItems(db, from, to) {
  const rows = db.prepare(`SELECT d.id, d.url, d.type, d.title, substr(d.description, 1, 400) AS description, d.site, d.source, d.author, d.image_url, d.published_at, d.engagement, d.meta FROM docs d
    WHERE d.published_at >= ? AND d.published_at < ? AND d.hidden = 0 AND d.type IN ('article', 'post') AND ${EN} AND ${NOT_COVERAGE}`).all(from, to);
  const items = [];
  for (const r of rows) {
    if (!r.title || !isAiRelated(`${r.title} ${r.description}`)) continue;
    let m = {};
    try {
      m = r.meta ? JSON.parse(r.meta) : {};
    } catch { /* no meta */ }
    const platform = m.platform || (r.site === 'x.com' ? 'x' : 'web');
    items.push({
      id: String(r.id),
      type: r.type,
      title: cleanTitle(r.title, r.source, r.site),
      summary: r.description,
      url: r.url,
      linkUrl: m.linkUrl,
      platform,
      handle: m.handle || (platform === 'x' ? r.author.replace(/^@/, '') : undefined),
      author: r.author,
      avatar: m.avatar,
      source: r.source || r.site,
      sourceHost: r.site,
      publishedAt: r.published_at,
      engagement: { score: r.engagement || 0 },
      image: r.image_url,
    });
  }
  return items;
}

// Share of headlines naming each company or theme, from titles + summaries.
function entityShares(rows) {
  const counts = new Map();
  for (const r of rows) for (const k of extractEntities(`${r.title} ${r.description || ''}`).keys()) counts.set(k, (counts.get(k) || 0) + 1);
  return { counts, n: rows.length };
}

// Named far more than usual: share today against the four weeks before.
export function standouts(today, before, { min = 4, limit = 8 } = {}) {
  const out = [];
  for (const [key, n] of today.counts) {
    if (n < min) continue;
    const share = n / Math.max(1, today.n);
    const base = (before.counts.get(key) || 0) / Math.max(1, before.n);
    // Smoothed so a name that's never been seen doesn't read as infinitely up.
    const lift = share / (base + 2 / Math.max(50, before.n));
    out.push({ key, label: topicLabel(key), n, share: +share.toFixed(4), base: +base.toFixed(4), lift: +lift.toFixed(2) });
  }
  return out.filter((t) => t.lift >= 1.5).sort((a, b) => b.lift * Math.log1p(b.n) - a.lift * Math.log1p(a.n)).slice(0, limit);
}

// Markets whose odds moved most within [from, to): first and last price.
function marketMoves(db, from, to, limit = 10) {
  const rows = db.prepare(`SELECT market, outcome, MIN(ts) AS t0, MAX(ts) AS t1 FROM odds WHERE ts >= ? AND ts < ? GROUP BY market, outcome`).all(from, to);
  const at = db.prepare('SELECT yes FROM odds WHERE market = ? AND outcome = ? AND ts = ?');
  const out = [];
  for (const r of rows) {
    if (r.t1 === r.t0) continue;
    const a = at.get(r.market, r.outcome, r.t0).yes;
    const b = at.get(r.market, r.outcome, r.t1).yes;
    if (Math.max(a, b) < 0.03) continue;
    out.push({ market: r.market, outcome: r.outcome, from: a, to: b, delta: +(b - a).toFixed(3) });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, limit);
}

// The headline most like the others in its story (the one that says what
// they all say), earliest on a tie; articles before posts.
export function centralHeadline(group) {
  const arts = group.filter((it) => it.type === 'article');
  const pool = arts.length ? arts : group;
  if (pool.length <= 2) return pool[0];
  const sets = pool.map((it) => new Set(tokens(it.title).filter((t) => t.length > 2 || /\d/.test(t))));
  let best = 0;
  let bestScore = -1;
  sets.forEach((a, i) => {
    let sc = 0;
    sets.forEach((b, j) => {
      if (i === j) return;
      let n = 0;
      for (const t of a) if (b.has(t)) n++;
      sc += n / Math.max(1, Math.sqrt(a.size * b.size));
    });
    if (sc > bestScore + 1e-9) [best, bestScore] = [i, sc];
  });
  return pool[best];
}

const outletsOf = (s) => new Set(s.sources.filter((x) => x.platform !== 'x').map((x) => x.name)).size;

export function computeDay(db, { day, now = Date.now() }) {
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = from + DAY;
  const items = dayItems(db, from, Math.min(to, now + 5 * 60e3));
  const stories = clusterItems(items).map((s) => ({
    s,
    outlets: outletsOf(s),
    sources: new Set(s.sources.map((x) => x.name)).size,
    eng: s._group.reduce((n, it) => n + (it.engagement.score || 0), 0),
  }));
  // Stories with X posts only rank by their outlets like everything else, so
  // a viral post doesn't crowd out what the press covered.
  stories.sort((a, b) => b.sources - a.sources || b.outlets - a.outlets || b.eng - a.eng || a.s.publishedAt - b.s.publishedAt);

  const top = stories.filter((x) => x.s._group.some((it) => it.type === 'article')).slice(0, 14).map(({ s, sources, outlets }) => {
    const group = [...s._group].sort((a, b) => a.publishedAt - b.publishedAt);
    const lead = centralHeadline(group);
    return {
      title: lead.title,
      url: lead.url,
      source: lead.source,
      host: lead.sourceHost,
      at: group[0].publishedAt,
      image: s.image || null,
      summary: (lead.summary || '').slice(0, 280),
      sources,
      outlets,
      entities: s.entities.slice(0, 4).map((k) => ({ key: k, label: topicLabel(k) })),
      items: group.filter((it, i) => it.url !== lead.url && group.findIndex((x) => x.source === it.source && x.title === it.title) === i).slice(0, 6).map((it) => ({ title: it.title, url: it.url, source: it.platform === 'x' ? `@${it.handle}` : it.source, host: it.sourceHost, at: it.publishedAt })),
    };
  });

  const posts = items.filter((it) => it.platform === 'x' && it.engagement.score > 0)
    .sort((a, b) => b.engagement.score - a.engagement.score)
    .slice(0, 6)
    .map((it) => ({ text: it.title.slice(0, 280), url: it.url, handle: it.handle, author: it.author, avatar: it.avatar || null, at: it.publishedAt, score: it.engagement.score }));

  const deals = groupDeals(dealMentions(db, { since: from, until: to - 1 }))
    .sort((a, b) => (b.amount || b.valuation || 0) - (a.amount || a.valuation || 0))
    .slice(0, 6)
    .map((d) => ({ kind: d.kind, company: d.company, companyKey: d.companyKey, acquirer: d.acquirer || null, amount: d.amount || null, valuation: d.valuation || null, round: d.round || null, talks: !!d.talks, url: d.first.url, site: d.first.site, outlets: d.outlets }));

  // Names: today against the 28 days before (titles + summaries).
  const titleRows = (a, b) => db.prepare(`SELECT d.title, substr(d.description, 1, 300) AS description FROM docs d
    WHERE d.published_at >= ? AND d.published_at < ? AND d.hidden = 0 AND d.type = 'article' AND ${EN} AND ${NOT_COVERAGE}`).all(a, b)
    .filter((r) => isAiRelated(`${r.title} ${r.description}`));
  const before = entityShares(titleRows(from - 28 * DAY, from));
  const names = standouts(entityShares(items.filter((it) => it.type === 'article').map((it) => ({ title: it.title, description: it.summary }))), before);

  const prev = db.prepare(`SELECT MAX(published_at) AS t FROM docs WHERE published_at < ? AND published_at >= ? AND type = 'article' AND hidden = 0`).get(from, from - 60 * DAY).t;
  const next = db.prepare(`SELECT MIN(published_at) AS t FROM docs WHERE published_at >= ? AND published_at < ? AND type = 'article' AND hidden = 0`).get(to, Math.min(to + 60 * DAY, now + 5 * 60e3)).t;
  return {
    day,
    partial: now < to,
    generatedAt: now,
    totals: {
      items: items.length,
      articles: items.filter((it) => it.type === 'article').length,
      posts: items.filter((it) => it.platform === 'x').length,
      stories: stories.length,
      outlets: new Set(items.filter((it) => it.platform !== 'x').map((it) => it.source)).size,
    },
    top,
    posts,
    deals,
    names,
    moves: marketMoves(db, from, to),
    prev: prev ? dayOf(prev) : null,
    next: next ? dayOf(next) : null,
  };
}

// ---- Server side ----

// Odds moves get their market's title and link from the live list; markets
// that have since closed and left it are dropped.
export function withMarkets(d, markets = []) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const moves = [];
  for (const mv of d.moves) {
    const m = byId.get(mv.market);
    if (!m || moves.some((x) => x.market === mv.market)) continue;
    moves.push({ ...mv, title: m.title, url: m.url, binary: !!m.binary });
    if (moves.length >= 4) break;
  }
  return { ...d, moves };
}

export function withReleases(d, releases = []) {
  const rel = releases.filter((r) => r.date && dayOf(r.date) === d.day).slice(0, 6)
    .map((r) => ({ id: r.id, name: r.name, provider: r.provider, url: r.url, open: !!r.open }));
  return { ...d, releases: rel };
}

export const dayQuery = (day) => {
  const today = dayOf(Date.now());
  return cachedJob(`day:${day}`, { kind: 'day', day }, day === today ? 10 * 60e3 : 6 * 3600e3);
};
export const calendarQuery = () => cachedJob('dayCalendar', { kind: 'dayCalendar' }, 30 * 60e3);
