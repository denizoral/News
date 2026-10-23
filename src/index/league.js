// The AI league table: the big labs ranked each week by their share of the
// news, with what moved: their rank a week ago, their share of X posts, the
// mood of their headlines, what they shipped, and the odds Polymarket gives
// them of having the best model at year's end, with the week's change. Two
// weeks of titles are read once; companies are found the way topics are.

import { extractEntities } from '../pipeline/classify.js';
import { splitOutlet } from '../pipeline/text.js';
import { toneOf, signOf } from '../pipeline/tone.js';
import { computeShipped } from './shipped.js';
import { DOSSIERS } from './dossier.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
const KEYS = Object.keys(DOSSIERS);

const bucket = () => ({ articles: 0, posts: 0, pos: 0, neg: 0, scored: 0 });

// markets: [{ id, title, outcomes: [{ label, yes }] }] from the live feed.
export function computeLeague(db, { now = Date.now(), markets = [], shipped = null } = {}) {
  const since = now - 14 * DAY;
  const rows = db.prepare(`SELECT title, type, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type IN ('article', 'post') AND published_at >= ? AND published_at <= ? AND hidden = 0`).all(since, now + 5 * 60e3);
  const totals = [bucket(), bucket()];
  const per = new Map(KEYS.map((k) => [k, { weeks: [bucket(), bucket()], days: new Array(14).fill(0) }]));
  const dayTotals = new Array(14).fill(0);
  const seen = new Set();
  for (const r of rows) {
    const { title } = splitOutlet(r.title || '');
    if (!title) continue;
    const key = title.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const w = r.at >= now - 7 * DAY ? 0 : 1;
    const d = Math.min(13, Math.floor((r.at - since) / DAY));
    const isPost = r.type === 'post';
    if (isPost) totals[w].posts++;
    else {
      totals[w].articles++;
      dayTotals[d]++;
    }
    let tone = null;
    for (const [k, strong] of extractEntities(title)) {
      const c = strong && per.get(k);
      if (!c) continue;
      const b = c.weeks[w];
      if (isPost) {
        b.posts++;
        continue;
      }
      b.articles++;
      c.days[d]++;
      tone ??= signOf(toneOf(title));
      b.scored++;
      if (tone > 0) b.pos++;
      else if (tone < 0) b.neg++;
    }
  }

  const ship = shipped || computeShipped(db, now);
  const best = markets.find((m) => /best AI model/i.test(m.title) && /end of (?:20\d\d|the year|year)/i.test(m.title)) || markets.find((m) => /best AI model/i.test(m.title));
  const oddsThen = best ? db.prepare('SELECT yes FROM odds WHERE market = ? AND outcome = ? AND ts <= ? ORDER BY ts DESC LIMIT 1') : null;

  const share = (b, t, f) => (t[f] ? b[f] / t[f] : 0);
  const out = KEYS.map((key) => {
    const c = per.get(key);
    const [now7, prev7] = c.weeks;
    const label = DOSSIERS[key].label;
    const outcome = best?.outcomes.find((o) => o.label.toLowerCase() === label.toLowerCase() || (key === 'google' && /^google|deepmind/i.test(o.label)) || (key === 'xai' && /^xai$/i.test(o.label)));
    const then = outcome ? oddsThen.get(best.id, outcome.label, now - 7 * DAY)?.yes : null;
    return {
      key,
      label,
      share: share(now7, totals[0], 'articles'),
      sharePrev: share(prev7, totals[1], 'articles'),
      xShare: share(now7, totals[0], 'posts'),
      xSharePrev: share(prev7, totals[1], 'posts'),
      articles: now7.articles,
      mood: now7.scored >= 10 ? Math.round(((now7.pos - now7.neg) / now7.scored) * 1000) / 10 : null,
      moodPrev: prev7.scored >= 10 ? Math.round(((prev7.pos - prev7.neg) / prev7.scored) * 1000) / 10 : null,
      shipped: ship.entries.filter((x) => DOSSIERS[key].shipped.includes(x.product) && x.at >= now - 7 * DAY).length,
      odds: outcome ? { yes: outcome.yes, prev: then ?? null, label: outcome.label } : null,
      days: c.days.map((n, i) => (dayTotals[i] ? n / dayTotals[i] : 0)),
    };
  });
  // Rank by share of the news, this week and last.
  const prevRank = new Map([...out].sort((a, b) => b.sharePrev - a.sharePrev).map((x, i) => [x.key, i + 1]));
  const table = [...out].sort((a, b) => b.share - a.share).map((x, i) => ({ ...x, rank: i + 1, prevRank: prevRank.get(x.key) }));
  const riser = [...table].sort((a, b) => (b.share - b.sharePrev) - (a.share - a.sharePrev))[0];
  return {
    generatedAt: now,
    market: best ? { title: best.title, url: best.url } : null,
    totals: { articles: totals[0].articles, posts: totals[0].posts, articlesPrev: totals[1].articles },
    table,
    stats: {
      leader: table[0] ? { label: table[0].label, share: table[0].share } : null,
      riser: riser ? { label: riser.label, change: riser.share - riser.sharePrev } : null,
      favourite: [...table].filter((x) => x.odds).sort((a, b) => b.odds.yes - a.odds.yes)[0] || null,
    },
  };
}

export const leagueQuery = (markets) => cachedJob('league', { kind: 'league', markets }, TTL_MS);
