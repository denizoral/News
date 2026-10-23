// AI by the numbers: the figures companies and reporters put on AI, read
// from a year of headlines. A figure is a company (the headline's subject:
// "Anthropic boasts revenue run rate of $30 billion"), a metric (run-rate
// revenue, reported revenue, losses, spending on compute and data centers,
// users), the amount nearest the metric's word, and its period when given
// (Q3, 1H 2026, this year, weekly users). Forecasts and targets are kept but
// marked, and so is "reportedly". The same figure reported within two weeks
// is one point; each company's points per metric make its history.

import { splitOutlet } from '../pipeline/text.js';
import { parseMoney } from './deals.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const NUMBER_DAYS = 365;

const FTS = 'title:(revenue OR revenues OR ARR OR annualized OR annualised OR "run rate" OR "run-rate" OR capex OR "capital expenditure" OR "capital expenditures" OR spending OR spend OR "weekly users" OR "monthly users" OR "daily users" OR "active users" OR subscribers OR users OR loss OR losses OR burned OR burn OR sales)';

// [key, label, subject pattern]; the subject must open the headline.
export const COMPANIES = [
  ['openai', 'OpenAI', /^(?:OpenAI|ChatGPT|Codex|Sora|Sam Altman)\b/],
  ['anthropic', 'Anthropic', /^(?:Anthropic|Claude|Dario Amodei)\b/],
  ['google', 'Google', /^(?:Google|Alphabet|Gemini|DeepMind|Google Cloud|Sundar Pichai)\b/],
  ['meta', 'Meta', /^(?:Meta|Meta AI|Mark Zuckerberg|Zuckerberg)\b/],
  ['microsoft', 'Microsoft', /^(?:Microsoft|Azure|Copilot|Satya Nadella)\b/],
  ['amazon', 'Amazon', /^(?:Amazon|AWS|Andy Jassy)\b/],
  ['nvidia', 'Nvidia', /^(?:Nvidia|NVIDIA|Jensen Huang)\b/],
  ['xai', 'xAI', /^(?:xAI|Grok|SpaceXAI|SpaceX AI)\b/],
  ['oracle', 'Oracle', /^(?:Oracle)\b/],
  ['coreweave', 'CoreWeave', /^(?:CoreWeave)\b/],
  ['perplexity', 'Perplexity', /^(?:Perplexity)\b/],
  ['cursor', 'Cursor', /^(?:Cursor|Anysphere)\b/],
  ['mistral', 'Mistral', /^(?:Mistral)\b/],
  ['apple', 'Apple', /^(?:Apple)\b/],
  ['bigtech', 'Big Tech combined', /^(?:Big Tech|Hyperscalers?|Google, Microsoft, Meta,? and Amazon|Microsoft, (?:Alphabet|Google), (?:Amazon|Meta))\b/i],
];
const LABEL = Object.fromEntries(COMPANIES.map(([k, l]) => [k, l]));

// Metrics, most specific first; each finds its word, then the nearest amount.
export const METRICS = [
  ['runrate', 'Run-rate revenue', /\b(?:ARR|annuali[sz]ed(?: revenue)?|run[- ]rate)\b/i],
  ['loss', 'Losses and burn', /\b(?:loss(?:es)?|lost|burn(?:ed|ing|s)?|burned through)\b/i],
  ['capex', 'Spending on compute', /\b(?:capex|capital expenditures?|capital spending|(?:AI|data[- ]cent(?:er|re)|infrastructure|compute) spend(?:ing)?|spend(?:ing)? on (?:AI|data[- ]cent(?:er|re)s?|infrastructure|compute)|to spend)\b/i],
  ['revenue', 'Revenue', /\b(?:revenues?|sales)\b/i],
  ['users', 'Users', /\b(?:weekly|monthly|daily)?\s*(?:active )?users\b|\bsubscribers\b|\bWAUs?\b|\bMAUs?\b|\bDAUs?\b/i],
];
const METRIC_LABEL = Object.fromEntries(METRICS.map(([k, l]) => [k, l]));

const MONEY = /([$€£])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(trillion|billion|million|bn|mn|tn|[bmt])?(?![\p{L}\p{N}])/giu;
const COUNT = /\b(\d+(?:\.\d+)?)\s*(billion|million|thousand|[bmk])\b(?!\s*(?:dollars|in revenue))/gi;
const OUTLOOK = /\bthrough 20\d\d\b|\bby the end of\b|\b(?:forecast\w*|expect\w*|project\w*|target\w*|plans?|planned|guidance|outlook|aims?|will|to hit|could|would|may|set to|on track|by 20\d\d|estimat\w*|predict\w*|sees|eyes)\b/i;
// A figure for part of the business (an ad product, a pilot, one product or
// division), not the company as a whole.
const PART = /\bads?\b|\badvertis\w*|\bpilot\b|\bClaude Code\b|\bCodex\b|\bcreators?\b|\bAzure\b|\bAWS\b|\bGoogle Cloud\b|\bcloud\b|\biPhone\b|\bdivision\b|\bsegment\b|\bunit\b|\bVR\b|\bReality Labs\b|\bon VR\b|\bSora\b|\bAPI\b/i;
const REPORTED = /\breported(?:ly)?\b|\breport\b|\bsources\b|\bsays (?:a )?report\b|\bthe information\b/i;
// Not company figures: stock tips, price targets, ad returns, reviews.
const NOT = /\bstatistics\b|\bstats\b|\bstocks? to\b|\bprice target\b|\bshould you\b|\bbuy\b(?! back)|\breview\b|\bvs\.?\b|\bper (?:user|dollar|share)\b|\bper-user\b|\bcould be worth\b|\bwhat to expect\b|\?$/i;

function periodOf(title) {
  const q = /\b(Q[1-4])(?:\s*(20\d\d))?\b/.exec(title);
  if (q) return q[2] ? `${q[1]} ${q[2]}` : q[1];
  const h = /\b(1H|2H|H1|H2|first half|second half)(?:\s+(?:of\s+)?(20\d\d))?\b/i.exec(title);
  if (h) return `${/^(1H|H1|first)/i.test(h[1]) ? '1H' : '2H'}${h[2] ? ` ${h[2]}` : ''}`;
  const y = /\b(?:in|for|during|this|next|fiscal|FY)\s*(20\d\d|year)\b/i.exec(title) || /\b(20\d\d)(?= (?:capex|capital|revenue|sales|spending|AI spending)\b)/i.exec(title);
  if (y) return y[1] === 'year' ? 'this year' : y[1];
  const w = /\b(weekly|monthly|daily)\b/i.exec(title);
  if (w) return w[1].toLowerCase();
  return null;
}

// The amount closest to the metric's word, within a few words of it.
function nearest(list, at, end) {
  const dist = (x) => (x.at >= end ? x.at - end : Math.max(0, at - x.end));
  return list.filter((x) => dist(x) <= 45).sort((a, b) => dist(a) - dist(b))[0] || null;
}
// Amounts that are something else: a valuation, a deal, a bond, a gap.
const AFTER_NOT = /^\s*(?:\+|-|–)?\s*(?:increase|rise|jump|hike|boost|cut|drop|IPO|valuation|bid|market cap|bond|deal|investment|loan|round|funding|stake|acquisition|lower|higher|more|less|short|below|above|gap|in (?:market value|market cap|value))\b/i;
const OTHERS = COMPANIES.map(([key, , re]) => [key, new RegExp(re.source.replace(/^\^/, '\\b'), re.flags)]);

// Every figure a headline states ("revenue to $5.7 billion … burned through
// $3.7 billion" is two), one per metric, no amount used twice.
export function parseNumbers(rawTitle) {
  const out = [];
  const used = new Set();
  for (const [key] of METRICS) {
    const p = parseNumber(rawTitle, { only: key, used });
    if (p) {
      out.push(p);
      used.add(p.at);
    }
  }
  return out;
}

export function parseNumber(rawTitle, { only = null, used = new Set() } = {}) {
  const { title } = splitOutlet(rawTitle.replace(/^\[[^\]]{1,30}\]\s*/, ''));
  if (NOT.test(title)) return null;
  const co = COMPANIES.find(([, , re]) => re.test(title.replace(/^(?:Exclusive|Report|Breaking|JUST IN)\s*[:|-]\s*/i, '')));
  if (!co) return null;
  for (const [key, , re] of METRICS) {
    if (only && key !== only) continue;
    const m = re.exec(title);
    if (!m) continue;
    // Another company named before the metric word: the figure may be theirs.
    const head = title.slice(0, m.index);
    if (OTHERS.some(([k, r]) => k !== co[0] && r.test(head.slice(8)))) return null;
    const end = m.index + m[0].length;
    if (key === 'users') {
      const counts = [...title.matchAll(COUNT)].map((c) => ({ v: Number(c[1]) * ({ billion: 1e9, b: 1e9, million: 1e6, m: 1e6, thousand: 1e3, k: 1e3 }[c[2].toLowerCase()]), at: c.index, end: c.index + c[0].length, raw: c[0] }))
        .filter((c) => !/[$€£]\s?$/.test(title.slice(Math.max(0, c.at - 2), c.at)));
      const c = nearest(counts.filter((x) => !used.has(x.at)), m.index, end);
      if (!c || c.v < 1e4) continue;
      return { title, at: c.at, company: co[0], metric: key, value: c.v, unit: 'people', part: /\bCodex\b|\bClaude Code\b|\bSora\b|\bMuse\b|\bCopilot\b/.test(title), period: periodOf(title) || (/\bsubscribers\b/i.test(title) ? 'subscribers' : null), outlook: OUTLOOK.test(title), reported: REPORTED.test(title) };
    }
    const amounts = [...title.matchAll(MONEY)].map((x) => ({ v: parseMoney(x[1], x[2], x[3]), at: x.index, end: x.index + x[0].length }))
      .filter((x) => {
        if (!x.v || x.v < 1e6 || AFTER_NOT.test(title.slice(x.end, x.end + 24))) return false;
        // "$100B in annual revenue" is revenue, whatever else the headline mentions.
        const own = /^\s*(?:in |of )?((?:[a-z-]+ ?){1,3})/i.exec(title.slice(x.end, x.end + 30))?.[1] || '';
        const theirs = METRICS.find(([, , r]) => r.test(own))?.[0];
        return !theirs || theirs === key;
      });
    const a = nearest(amounts.filter((x) => !used.has(x.at)), m.index, end);
    if (!a) continue;
    return { title, at: a.at, company: co[0], metric: key, value: a.v, unit: 'usd', part: PART.test(title), period: periodOf(title), outlook: OUTLOOK.test(title), reported: REPORTED.test(title) };
  }
  return null;
}

export function computeNumbers(db, now = Date.now(), days = NUMBER_DAYS) {
  const rows = db.prepare(`SELECT title, url, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, now - days * DAY, now + 5 * 60e3);
  const points = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title || '');
    if (!title || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue;
    const found = parseNumbers(r.title);
    if (!found.length) continue;
    headlines++;
    const source = outlet || r.source || r.site;
    for (const { at: _pos, ...p } of found) {
      // The same figure (within 2%) for the same company and metric within two weeks.
      const same = points.find((x) => x.company === p.company && x.metric === p.metric && r.at - x.last < 14 * DAY && Math.abs(x.value - p.value) <= x.value * 0.02);
      if (same) {
        same.last = r.at;
        same.outlets.add(source);
        same.period ||= p.period;
        // Confirmed by an outlet that isn't hedging.
        if (!p.reported) same.reported = false;
        continue;
      }
      points.push({ ...p, at: r.at, last: r.at, url: r.url, source, outlets: new Set([source]) });
    }
  }
  const out = points.map((x) => ({
    id: `${x.company}-${x.metric}-${new Date(x.at).toISOString().slice(0, 10)}-${Math.round(x.value / 1e6)}`,
    at: x.at,
    company: x.company,
    metric: x.metric,
    value: x.value,
    unit: x.unit,
    period: x.period,
    outlook: x.outlook,
    part: x.part,
    reported: x.reported,
    title: x.title,
    url: x.url,
    source: x.source,
    outlets: x.outlets.size,
  })).sort((a, b) => b.at - a.at);

  // For each metric, each company's latest actual figure (not an outlook)
  // and its history, oldest first.
  const board = METRICS.map(([metric, label]) => {
    const rowsFor = COMPANIES.map(([company]) => {
      const list = out.filter((x) => x.company === company && x.metric === metric);
      if (!list.length) return null;
      // The latest figure for the whole company, else the latest actual, else anything.
      const latest = list.find((x) => !x.outlook && !x.part) || list.find((x) => !x.outlook) || list[0];
      return { company, label: LABEL[company], latest, history: [...list].reverse().slice(-12) };
    }).filter(Boolean).sort((a, b) => b.latest.value - a.latest.value);
    return { metric, label, companies: rowsFor };
  }).filter((m) => m.companies.length);
  return {
    generatedAt: now,
    days,
    headlines,
    points: out.slice(0, 500),
    board,
    companies: COMPANIES.map(([key, label]) => ({ key, label, n: out.filter((x) => x.company === key).length })).filter((c) => c.n).sort((a, b) => b.n - a.n),
    labels: { companies: LABEL, metrics: METRIC_LABEL },
    stats: {
      points: out.length,
      n30: out.filter((x) => x.at >= now - 30 * DAY).length,
      companies: new Set(out.map((x) => x.company)).size,
      topRunrate: board.find((m) => m.metric === 'runrate')?.companies[0] || null,
      topUsers: board.find((m) => m.metric === 'users')?.companies[0] || null,
    },
  };
}

export const numbersQuery = () => cachedJob('numbers', { kind: 'numbers' }, TTL_MS);
