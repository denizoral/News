// Deals: funding rounds, valuations and acquisitions, read out of headlines.
//
// A full-text query finds headlines with a deal verb ("raises", "acquires",
// "valued at"); each is parsed for who, how much, which round, at what
// valuation and from whom. Headlines about the same company, the same kind of
// deal and a similar amount within a few weeks are one deal, reported by
// however many outlets carried it; the earliest is the first report.
//
// Amounts are in US dollars (euros and pounds at a fixed rate, flagged).
// Headlines that only report talks ("in talks to raise") are kept as talks
// and left out of the totals. Runs in the history worker, cached.

import { cachedJob } from './offload.js';
import { isAiRelated } from '../pipeline/classify.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
export const RANGES = { '90d': 90, '1y': 365, '2y': 730 };
const FX = { $: 1, '€': 1.08, '£': 1.27 };
const UNIT = { trillion: 1e12, tn: 1e12, t: 1e12, billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, m: 1e6, k: 1e3, thousand: 1e3 };

const MONEY = /([$€£])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mn|tn|[bmkt])?(?![\p{L}\p{N}])/giu;
const FUND_VERB = /\b(seeks|seeking|raises|raised|raising|raise|secures|secured|closes|closed|lands|landed|nabs|nabbed|bags|bagged|grabs|snags|snagged|gets|got|picks up|picked up|scores|attracts|draws|receives)\b/i;
const BUY_VERB = /(?<![-\w])(acquires|acquired|to acquire|will acquire|buys|bought|to buy|will buy|snaps up|scoops up|agrees to buy|agrees to acquire|completes acquisition of|completes purchase of)\b/i;
const VALUE_VERB = /\b(valued at|now valued|hits|reaches|nears|tops|topping|doubles valuation|triples valuation|valuation (?:soars|jumps|climbs|rises) to)\b/i;
const TALKS = /\b(in talks|talks to|seeks|seeking|looks to|looking to|plans to|planning to|aims to|weighs|weighing|considers|considering|eyes|eyeing|nears deal|could|may|reportedly|in discussions|explores|exploring|bid to|offers to|offer to)\b/i;
const ROUND = /\b(pre-seed|seed|series\s+([a-h])\b|growth round|growth funding|growth financing|debt|venture debt|credit facility|loan|bridge round)/i;
// Not a company: funds and campaigns, revenue and spending, chips bought.
const SKIP = /\b(fund|funds|PAC|revenue|sales|spent|spends|spending|budget|grant|grants|award|prize|salary|pay package|fine|fined|lawsuit|settlement|bonds?|IPO|layoffs?|recap|weekly|roundup|this week|contracts?|orders?|deal|deals|partnership|tranche|stocks?|shares|rating|price targets?|data ?cent(?:er|re)s?)\b/i;
// Words that describe a company rather than name it ("AI startup Harvey").
const DESCRIPTOR = new Set('app apps tool companion assistant service network marketplace startup start-up startups company firm maker developer provider platform unicorn lab labs rival giant founder founders creator creators owner backer parent operator specialist pioneer leader player upstart outfit spinout spin-off venture'.split(' '));
const NOT_NAMES = new Set('AI Exclusive Confirmed Report Reports Breaking Update Updated Sources Source Report: The A An This That Why How What Who When Startup Startups Company Companies Inc Corp LLC Ltd PAC Gen GenAI Generative Agentic Robotics Chip Chips Legal Health Fintech Biotech Defense Defence Security Data Cloud Voice Video Search Coding Code Open Source New Big Former Ex Chinese French German British Indian Israeli Japanese Korean European American US U.S. UK Canadian Swiss Swedish Dutch Australian Singapore Stealth CEO CTO Billionaire Tech Stocks Where Why Signs Definitive Agreement Trillion Billion Million Start-ups Startups Agent Agents Itself'.split(' '));
// Words allowed between the verb and the amount ("raises a fresh $50M").
const FILLER = new Set('a an another new fresh up to over more than nearly about around roughly almost additional record record-breaking extra further its first second third initial whopping massive us raise raising'.split(' '));
// Words between a name and its verb ("OpenAI Is Racing to Raise", "X just raised").
const BRIDGE = new Set('is are was were has have had will would to set racing rushing preparing aiming looking planning hoping trying moving just now reportedly officially quietly finally also again said says'.split(' '));

const clean = (title) => title
  .replace(/\s+[|–—-]\s+[^|–—-]{2,40}$/u, '') // " | TechCrunch", " - Reuters"
  .replace(/^\[[^\]]{1,30}\]\s*/, '') // "[AINews] "
  .replace(/^(?:exclusive|confirmed|scoop|report|breaking|update|sources?|ft|wsj)\s*[:|-]\s*/i, '')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .trim();

export function parseMoney(sym, num, unit) {
  const n = Number(String(num).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = unit ? UNIT[unit.toLowerCase()] : 1;
  // "$5B" and "$500M" but not a bare "$5" (a price, not a deal).
  if (!mult || (mult === 1 && n < 1e4)) return null;
  return Math.round(n * mult * FX[sym]);
}

function moneyIn(text) {
  MONEY.lastIndex = 0;
  const out = [];
  for (const m of text.matchAll(MONEY)) {
    const usd = parseMoney(m[1], m[2], m[3]);
    if (usd) out.push({ usd, at: m.index, end: m.index + m[0].length, fx: m[1] !== '$' });
  }
  return out;
}

// The name just before the verb: the run of capitalised words that ends there,
// starting after any descriptor ("Legal AI startup Harvey" -> "Harvey").
export function nameBefore(text) {
  let s = text.trim();
  // "ArtMaster, previously backed by Robert Kyncl, raises": the subject comes first.
  if (/,\s*$/.test(s) && s.indexOf(',') < s.length - 1) s = s.slice(0, s.indexOf(','));
  s = s.replace(/\s+(?:signs?|signed|enters?|entered|announces?|announced|completes?|completed|reaches?|reached|strikes?|struck)\b.*$/i, '');
  const words = s.replace(/[,:;]+$/, '').split(/\s+/);
  const out = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].replace(/^["'(]+|["')]+$/g, '');
    if (!out.length && BRIDGE.has(w.toLowerCase())) continue;
    if (!w || DESCRIPTOR.has(w.toLowerCase()) || /-(?:based|backed|owned|led|funded)$/i.test(w)) break;
    if (/['’]s$/.test(w) && out.length) break; // "India's Physics Wallah"
    if (!/^[\p{Lu}\p{N}]/u.test(w) && !/^[a-z]+[A-Z]/.test(w) && !(out.length && /^(?:&|and|de|of|la)$/.test(w))) break;
    out.unshift(w.replace(/['’]s$/, ''));
    if (out.length > 4) return null;
  }
  while (out.length && /^(?:&|and|de|of|la)$/.test(out[0])) out.shift();
  while (out.length && NOT_NAMES.has(out[0])) out.shift();
  const name = out.join(' ').replace(/[,.]+$/, '');
  if (!name || name.length < 2 || NOT_NAMES.has(name) || /^\d+$/.test(name) || /^[$€£]/.test(name)) return null;
  return name;
}

// The name just after the verb ("acquires Oosto for $125M" -> "Oosto").
function nameAfter(text) {
  const words = text.trim().split(/\s+/);
  const out = [];
  for (const raw of words) {
    const w = raw.replace(/^["'(]+|["'),:;.]+$/g, '');
    if (!out.length && /^(?:AI|startup|the|a|an|rival|chipmaker|firm|company|maker|developer|platform)$/i.test(w)) continue;
    if (w === '&' && out.length) { out.push(w); continue; }
    if (!/^[\p{Lu}\p{N}]/u.test(w) && !/^[a-z]+[A-Z]/.test(w)) break;
    if (DESCRIPTOR.has(w.toLowerCase())) { out.length = 0; continue; }
    if (/^(?:For|In|To|At|With|From|And|As|After|Amid|Over|Deal|Startup|Unit|Stake)$/.test(w)) break;
    if (/['’]s$/.test(w)) {
      // "Google's Chrome Browser": the thing after the possessive is the target.
      const next = words[words.indexOf(raw) + 1] || '';
      if (/^[\p{Lu}]/u.test(next)) { out.length = 0; continue; }
      out.push(w.replace(/['’]s$/, ''));
      break;
    }
    out.push(w);
    if (/[,:;.)]$/.test(raw) || out.length >= 4) break;
  }
  // "iPhone architect's startup": a name followed by someone's isn't the target.
  const rest = words[words.findIndex((x, i) => i >= out.length && !/^[\p{Lu}\p{N}&]/u.test(x))] || '';
  if (out.length && /^[a-z]+['’]s$/.test(rest)) return null;
  while (out.length && out[out.length - 1] === '&') out.pop();
  const name = out.join(' ');
  return name && !NOT_NAMES.has(name) && !NOT_NAMES.has(out[0]) && !/^[$€£\d]/.test(name) ? name : null;
}

function roundOf(text) {
  const m = text.match(ROUND);
  if (!m) return null;
  if (m[2]) return `Series ${m[2].toUpperCase()}`;
  const r = m[1].toLowerCase();
  return r === 'pre-seed' ? 'Pre-seed' : r === 'seed' ? 'Seed' : /debt|credit|loan/.test(r) ? 'Debt' : /bridge/.test(r) ? 'Bridge' : 'Growth';
}

// Seed, early (A–B), late (C and up, growth), or not given.
export function stageOf(round) {
  if (!round) return 'unknown';
  if (/seed/i.test(round)) return 'seed';
  if (/Series [AB]$/.test(round)) return 'early';
  if (/Series [C-H]$|Growth/.test(round)) return 'late';
  return 'unknown';
}

const INVESTOR = /\b(?:led by|from|backed by|co-led by)\s+((?:[\p{Lu}\p{N}][\p{L}\p{N}.&'’-]*|a16z)(?:\s+(?:[\p{Lu}\p{N}][\p{L}\p{N}.&'’-]*|&))*)/gu;
function investorsIn(text) {
  const out = [];
  for (const m of text.matchAll(INVESTOR)) {
    const name = m[1].replace(/[.,]+$/, '').replace(/['’]s$/, '').replace(/\s+&$/, '').trim();
    if (name.length > 1 && !NOT_NAMES.has(name) && !/^(?:Series|Seed)\b/.test(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 4);
}

// One headline -> a deal mention, or null.
export function parseDeal(rawTitle, description = '') {
  const t = clean(rawTitle);
  if (!t || t.length > 220 || /\?/.test(t)) return null;
  const money = moneyIn(t);
  const talks = TALKS.test(t);
  const valuation = (() => {
    const m = t.match(/(?:valued at|valuation of|at an? |at )(?:about |around |roughly |over |more than |nearly |almost |up to |)([$€£]\s?[\d.,]+\s*(?:trillion|billion|million|bn|mn|tn|[bmkt])?)\s*(?:valuation|post-money|pre-money)?/i)
      || t.match(/([$€£]\s?[\d.,]+\s*(?:trillion|billion|million|bn|mn|tn|[bmkt])?)\s+valuation/i);
    if (!m) return null;
    const v = moneyIn(m[1])[0];
    return v && v.usd >= 1e7 ? v.usd : null;
  })();

  const buy = t.match(BUY_VERB);
  if (buy && /\b(stocks?|shares|where to|how to|should you|buy now|buy rating|tickets?)\b/i.test(t)) return null;
  if (buy) {
    const before = t.slice(0, buy.index).replace(TALKS, ' ').replace(/\b(?:to|will|agrees|agreed|set|is|are)\s*$/i, '');
    const acquirer = nameBefore(before);
    const target = nameAfter(t.slice(buy.index + buy[0].length));
    if (!acquirer || !target || acquirer === target) return null;
    // "buys chips", "buys stake": a target has to look like a company.
    if (/^(?:Chips?|GPUs?|Shares|Stake|Stock|Land|Back|Out|Into|More|Time|Up)$/i.test(target.split(' ')[0])) return null;
    const after = t.slice(buy.index);
    const price = moneyIn(after).find((m) => /\bfor\s*$|\bin\s+(?:a\s+)?$|\bworth\s*$/i.test(after.slice(Math.max(0, m.at - 14), m.at)));
    return { kind: 'acquisition', company: target, acquirer, amount: price?.usd || null, fx: !!price?.fx, valuation: null, round: null, talks, investors: [] };
  }

  if (SKIP.test(t)) return null;
  const fund = t.match(FUND_VERB);
  if (fund) {
    // The amount has to follow the verb closely ("raises $27M", "secures a $2.3 billion round").
    const after = t.slice(fund.index + fund[0].length);
    const first = moneyIn(after)[0];
    const gap = first ? after.slice(0, first.at).toLowerCase().replace(/[~,]/g, ' ').split(/\s+/).filter(Boolean) : [];
    const subject = t.slice(0, fund.index).trim().split(/\s+/);
    if (first && gap.every((w) => FILLER.has(w)) && subject.length <= 8 && !/^\s*(?:post-money\s+|pre-money\s+)?valuation/i.test(after.slice(first.end, first.end + 30))
      && !/\bfor\s+(?:[\w-]+\s+){0,3}startups\b/i.test(after)) {
      const company = nameBefore(t.slice(0, fund.index).replace(TALKS, ' ').replace(/\b(?:to|is|has|have|just|reportedly|officially|quietly|now)\s*$/i, '').replace(/\b(?:to|is|has|have|just|reportedly|officially|quietly|now)\s*$/i, ''));
      if (!company) return null;
      const text = `${t}. ${description.slice(0, 400)}`;
      return { kind: 'funding', company, acquirer: null, amount: first.usd, fx: first.fx, valuation: valuation && valuation > first.usd ? valuation : null, round: roundOf(t) || roundOf(description.slice(0, 300)), talks, investors: investorsIn(text) };
    }
  }
  const val = t.match(VALUE_VERB);
  if (val && valuation) {
    const company = nameBefore(t.slice(0, val.index).replace(TALKS, ' ').replace(/\b(?:now|is|has|to)\s*$/i, ''));
    if (!company) return null;
    return { kind: 'valuation', company, acquirer: null, amount: null, fx: false, valuation, round: null, talks, investors: [] };
  }
  return null;
}

export const companyKey = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\b(?:inc|corp|ltd|llc|technologies|labs?|ai|hq)\b/g, '').trim().replace(/\s+/g, '-') || name.toLowerCase();

const near = (a, b) => !a || !b || Math.max(a, b) / Math.min(a, b) <= 1.4;
const mode = (xs) => {
  const c = new Map();
  for (const x of xs) if (x != null) c.set(x, (c.get(x) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// Same company: equal keys, or one is the other plus words ("orchestra" and
// "orchestra-bio").
const sameCo = (a, b) => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);

// Mentions -> deals: same company and kind, close in time and amount. A
// headline that only reports a valuation joins a round near it in time.
export function groupDeals(mentions, { gapDays = 30 } = {}) {
  const deals = [];
  // "Anthropic raises $965B" where everyone else says it was valued at $965B.
  const vals = mentions.filter((m) => m.valuation);
  const misprint = (m) => m.kind === 'funding' && vals.some((v) => v !== m && Math.abs(v.at - m.at) <= gapDays * DAY && sameCo(companyKey(v.company), companyKey(m.company)) && Math.abs(v.valuation - m.amount) / v.valuation < 0.02);
  const sorted = mentions.filter((m) => !misprint(m)).sort((a, b) => a.at - b.at);
  const join = (m, kind) => deals.find((x) => x.kind === kind && m.at - x.last <= gapDays * DAY && x.at - m.at <= gapDays * DAY && sameCo(x.co, companyKey(m.company))
    && (kind !== 'acquisition' || sameCo(companyKey(x.acquirers[0]), companyKey(m.acquirer)))
    && (m.kind === 'valuation' || near(x.amount, m.amount)));
  for (const m of sorted.filter((x) => x.kind !== 'valuation')) {
    const d = join(m, m.kind);
    if (d) {
      d.mentions.push(m);
      d.last = Math.max(d.last, m.at);
      if (!d.amount && m.amount) d.amount = m.amount;
    } else {
      deals.push({ kind: m.kind, co: companyKey(m.company), mentions: [m], at: m.at, last: m.at, amount: m.amount, acquirers: [m.acquirer] });
    }
  }
  for (const m of sorted.filter((x) => x.kind === 'valuation')) {
    const d = join(m, 'funding') || join(m, 'valuation');
    if (d) {
      d.mentions.push(m);
      d.last = Math.max(d.last, m.at);
    } else {
      deals.push({ kind: 'valuation', co: companyKey(m.company), mentions: [m], at: m.at, last: m.at, amount: null, acquirers: [null] });
    }
  }
  return deals.map((d) => {
    const ms = d.mentions.sort((a, b) => a.at - b.at);
    const sites = [...new Set(ms.map((m) => m.site))];
    const done = ms.filter((m) => !m.talks);
    const amounts = (done.length ? done : ms).filter((m) => m.kind === d.kind).map((m) => m.amount).filter(Boolean);
    return {
      id: `${companyKey(mode(ms.map((m) => m.company)))}-${d.kind}-${Math.floor(d.at / DAY)}`,
      kind: d.kind,
      company: mode(ms.map((m) => m.company)),
      companyKey: companyKey(mode(ms.map((m) => m.company))),
      acquirer: d.kind === 'acquisition' ? mode(ms.map((m) => m.acquirer)) : null,
      amount: mode(amounts) ?? amounts[0] ?? null,
      fx: ms.some((m) => m.fx),
      // The valuation most outlets gave ("nears $1 trillion" loses to "$965B").
      valuation: mode(ms.map((m) => m.valuation)),
      round: mode(ms.map((m) => m.round)),
      stage: stageOf(mode(ms.map((m) => m.round))),
      talks: !done.length,
      investors: [...new Set(ms.flatMap((m) => m.investors))].slice(0, 5),
      at: d.at,
      outlets: sites.length,
      first: { title: ms[0].title, url: ms[0].url, site: ms[0].site },
      docs: ms.slice(0, 8).map((m) => ({ title: m.title, url: m.url, site: m.site, at: m.at })),
    };
  });
}

const QUERY = "{title} : (raises OR raised OR raising OR raise OR secures OR secured OR closes OR lands OR nabs OR bags OR snags OR gets OR acquires OR acquire OR acquired OR buys OR buy OR acquisition OR valuation OR valued OR funding OR round)";

export function dealMentions(db, { since = 0, until = Date.now() + 3600e3, ai = true } = {}) {
  // Only dated pages: an undated archive page ("NVIDIA to Acquire Mellanox")
  // would otherwise count as news from the day we found it.
  const rows = db.prepare(`SELECT d.title, substr(d.description, 1, 400) AS description, d.url, d.site, d.published_at AS at
    FROM docs_fts f JOIN docs d ON d.id = f.rowid
    WHERE docs_fts MATCH ? AND d.hidden = 0 AND d.type = 'article' AND (d.lang IS NULL OR d.lang = '' OR d.lang LIKE 'en%')
      AND +d.published_at BETWEEN ? AND ?`).all(QUERY, since, until);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    const p = parseDeal(r.title, r.description || '');
    if (!p) continue;
    if (ai && !isAiRelated(`${r.title} ${r.description || ''}`)) continue;
    out.push({ ...p, title: clean(r.title), url: r.url, site: r.site, at: r.at });
  }
  return out;
}

// Calendar month (UTC) or Monday-started week.
const bucketStart = (ms, unit) => {
  const d = new Date(ms);
  if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Math.floor(ms / DAY);
  return (day - ((day + 3) % 7)) * DAY;
};

export function computeDeals(db, { range = '1y', now = Date.now() } = {}) {
  const days = RANGES[range] || RANGES['1y'];
  const since = now - days * DAY;
  const deals = groupDeals(dealMentions(db, { since: since - 30 * DAY, until: now + 3600e3 })).filter((d) => d.at >= since);
  const unit = days <= 90 ? 'week' : 'month';
  const buckets = [];
  for (let t = bucketStart(since, unit); t <= now; t = unit === 'week' ? t + 7 * DAY : bucketStart(t + 32 * DAY, 'month')) buckets.push(t);
  const stages = ['seed', 'early', 'late', 'unknown'];
  const series = Object.fromEntries(stages.map((s) => [s, buckets.map(() => 0)]));
  const counts = buckets.map(() => 0);
  const announced = deals.filter((d) => d.kind === 'funding' && !d.talks && d.amount);
  for (const d of announced) {
    const i = buckets.findLastIndex((b) => b <= d.at);
    if (i < 0) continue;
    series[d.stage][i] += d.amount;
    counts[i]++;
  }
  const buys = deals.filter((d) => d.kind === 'acquisition' && !d.talks);
  const biggest = announced.reduce((a, d) => (!a || d.amount > a.amount ? d : a), null);
  // Who raised most in the window, and who keeps raising.
  const byCo = new Map();
  for (const d of announced) {
    const c = byCo.get(d.companyKey) || { key: d.companyKey, company: d.company, raised: 0, rounds: 0, valuation: null };
    c.raised += d.amount;
    c.rounds++;
    c.valuation = Math.max(c.valuation || 0, d.valuation || 0) || null;
    byCo.set(d.companyKey, c);
  }
  return {
    range,
    days,
    unit,
    generatedAt: now,
    totals: {
      raised: announced.reduce((a, d) => a + d.amount, 0),
      rounds: announced.length,
      acquisitions: buys.length,
      acquisitionValue: buys.reduce((a, d) => a + (d.amount || 0), 0),
      talks: deals.filter((d) => d.talks).length,
      biggest: biggest && { company: biggest.company, amount: biggest.amount, id: biggest.id },
    },
    buckets,
    stages,
    raised: series,
    counts,
    top: [...byCo.values()].sort((a, b) => b.raised - a.raised).slice(0, 10),
    deals: deals.sort((a, b) => b.at - a.at),
  };
}

// Every deal on record for one company (as the target, the raiser or the
// buyer), oldest first, with its valuation history.
export function companyDeals(db, { key, now = Date.now() }) {
  const all = groupDeals(dealMentions(db, { since: 0, until: now + 3600e3 }));
  const deals = all.filter((d) => d.companyKey === key || (d.acquirer && companyKey(d.acquirer) === key)).sort((a, b) => a.at - b.at);
  if (!deals.length) return null;
  const own = deals.filter((d) => d.companyKey === key);
  return {
    key,
    company: mode(own.map((d) => d.company)) || mode(deals.map((d) => d.acquirer)),
    raised: own.filter((d) => d.kind === 'funding' && !d.talks).reduce((a, d) => a + (d.amount || 0), 0),
    valuations: own.filter((d) => d.valuation && !d.talks).map((d) => ({ at: d.at, valuation: d.valuation, round: d.round })),
    deals,
  };
}

export const dealsQuery = (range) => cachedJob(`deals:${RANGES[range] ? range : '1y'}`, { kind: 'deals', range: RANGES[range] ? range : '1y' }, TTL_MS);
export const companyDealsQuery = (key) => cachedJob(`deals:co:${key}`, { kind: 'companyDeals', key }, TTL_MS);
