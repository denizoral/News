// What's coming: dates in AI news. Headlines from the last 45 days that name
// a future date ("leaves the API on January 14", "event on October 28",
// "starting next month", "in Q1 2027") are resolved against the day they
// were published, sorted into launches, events, deadlines and retirements,
// and grouped when outlets report the same date for the same thing. The
// prediction markets that close on each day are added from the live feed.
// Day-precise dates export as an iCalendar feed.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
export const LOOKBACK_DAYS = 45;
export const AHEAD_DAYS = 400;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const monthIndex = (s) => MONTHS.indexOf(s.slice(0, 3).toLowerCase());
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const utcDay = (y, m, d) => Date.UTC(y, m, d);

// Looking back at the past ("in January 2025 he predicted"), not ahead.
const PAST = /\b(?:announcements|roundup|predicted|said|was|were|had|did|tried|happened|announced|acknowledged|fell|rose|posted|incidents?|last|ago|since|recap|review|looking back|dusting off)\b|\bfrom \w+ \d{1,2} to\b/i;
// "in March" or "on Monday" is a plan only next to a word that looks ahead;
// "by March", "until March" and "starting March" look ahead themselves.
const FUTURE = /\b(?:will|to be|set to|plans? to|planned|planning|expected|expects|coming|scheduled|due|poised|reportedly|may|could|to (?:hold|launch|unveil|release|announce|report|open|start|begin|host|ship|arrive|retire))\b/i;

// Every future date a headline names, resolved against the day it ran.
// [{ date: 'YYYY-MM-DD', precision: 'day' | 'week' | 'month' | 'quarter' }]
export function datesIn(title, publishedAt) {
  const pub = new Date(publishedAt);
  if (PAST.test(title)) return [];
  const ahead_ = FUTURE.test(title);
  const y0 = pub.getUTCFullYear();
  const pubDay = utcDay(y0, pub.getUTCMonth(), pub.getUTCDate());
  const out = [];
  // The next time a month (and day) comes round, unless the year is given.
  const ahead = (m, d, y) => {
    if (y) return utcDay(y, m, d);
    let t = utcDay(y0, m, d);
    if (t < pubDay - 7 * DAY) t = utcDay(y0 + 1, m, d);
    return t;
  };
  for (const m of title.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d))?(?!\\s*(?:%|percent|billion|million|years?|GB|TB|[BMK]\\b))`, 'gi'))) {
    const d = Number(m[2]);
    if (d < 1 || d > 31) continue;
    // "Oct 8 to 15" is a past range more often than a plan.
    if (/^\s*(?:to|-|–)\s*\d/.test(title.slice(m.index + m[0].length))) continue;
    out.push({ date: iso(ahead(monthIndex(m[1]), d, m[3] && Number(m[3]))), precision: 'day' });
  }
  for (const m of title.matchAll(new RegExp(`\\b(in|by|this|until|from|starting|during|before|end of|early|late|mid-?)\\s+${MON}\\b(?!\\.?\\s+\\d{1,2}\\b)(?:\\s+(20\\d\\d))?`, 'gi'))) {
    const lead = m[1].toLowerCase();
    const ownCue = ['by', 'until', 'starting', 'before', 'end of'].includes(lead);
    // Keep the capture groups the code below reads.
    m[1] = m[2];
    m[2] = m[3];
    if (!ahead_ && !ownCue && !m[2]) continue;
    const mi = monthIndex(m[1]);
    const y = m[2] ? Number(m[2]) : mi < pub.getUTCMonth() ? y0 + 1 : y0;
    if (!m[2] && mi === pub.getUTCMonth() && !/\bthis\b/i.test(m[0])) continue; // "in October" said in October is often about the past
    out.push({ date: iso(utcDay(y, mi, 1)), precision: 'month' });
  }
  for (const m of title.matchAll(/\bQ([1-4])\s+(20\d\d)\b/g)) out.push({ date: iso(utcDay(Number(m[2]), (Number(m[1]) - 1) * 3, 1)), precision: 'quarter' });
  if (/\bnext week\b/i.test(title)) {
    const t = pubDay + 7 * DAY;
    const dow = new Date(t).getUTCDay();
    out.push({ date: iso(t - ((dow + 6) % 7) * DAY), precision: 'week' });
  }
  if (/\bnext month\b/i.test(title)) {
    const m = pub.getUTCMonth() + 1;
    out.push({ date: iso(utcDay(y0 + (m > 11 ? 1 : 0), m % 12, 1)), precision: 'month' });
  }
  const wd = /\b(?:on|this|next|coming)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.exec(title);
  if (wd && ahead_) {
    const want = DAYS.indexOf(wd[1].toLowerCase());
    let gap = (want - pub.getUTCDay() + 7) % 7 || 7;
    if (/^next/i.test(wd[0]) && gap < 7) gap += 0;
    out.push({ date: iso(pubDay + gap * DAY), precision: 'day' });
  }
  return out;
}

// What the date is for, most specific first.
export const KINDS = [
  ['retire', 'Retirements and shutdowns', /\b(?:sunset\w*|retir\w*|deprecat\w*|leaves? (?:the )?(?:api|model selector|chatgpt|app)|leaves? (?:\S+ ){0,2}(?:api|app)|leaving|shut(?:s|ting)? down|shutdown|end(?:s|ing)? support|discontinu\w*|los(?:e|es|ing) access|phas\w* out|drops?|cut(?:s|ting)? (?:\S+ ){0,3}(?:users?|models?|access)|goes away|kill(?:s|ing)? off|removed? from)\b/i],
  ['deadline', 'Deadlines and rules', /\bdeadline\b|\buntil\b|\bmust\b|\bsubmit\w*|\bcomply\b|\bcompliance\b|\btakes? effect\b|\beffective\b|\benforce\w*|\bcomes? into force\b|\brules?\b|\blaw\b|\bact\b|\bban\w*|\bterms\b|\bpolicy\b|\bobligations?\b|\bresponsible\b|\bunder oath\b|\bhearing\b|\btrial\b|\bvote\b|\bcourt\b/i],
  ['event', 'Events and earnings', /\bevent\b|\bkeynote\b|\bconference\b|\bsummit\b|\bexpo\b|\bI\/O\b|\bWWDC\b|\bGTC\b|\bDevDay\b|\bCES\b|\bBuild\b|\bre:Invent\b|\blivestream\b|\bshowcase\b|\bearnings\b|\bresults\b|\breport(?:s)? (?:its )?(?:q[1-4]|quarter)\b|\bIPO\b|\blisting\b|\bfunding round\b|\bwhat to expect\b|\bhands-on\b|\bunpacked\b|\bshow\b/i],
  ['launch', 'Launches and arrivals', /\blaunch\w*|\brelease\w*|\bcoming\b|\bcomes? to\b|\barriv\w*|\brolls? out\b|\brollout\b|\bavailable\b|\bships?\b|\bdebut\w*|\bunveil\w*|\bgoes? live\b|\bopens?\b|\bstarts?\b|\bstarting\b|\bbegins?\b|\badds?\b|\bgets?\b|\bupgrade\w*|\bplanned\b|\bexpected\b|\bset to\b|\bwill\b/i],
];
const KIND_LABEL = Object.fromEntries([...KINDS.map(([k, l]) => [k, l]), ['market', 'Markets closing']]);
// Not about AI or not a date worth keeping.
const NOT = /\bregister now\b|\bwebinar\b|\bPaper page\b|\barXiv\b|\bstocks? to buy\b|\bprice prediction\b|\bhoroscope\b|\bweather\b|\bsports?\b|\bNFL\b|\bNBA\b|\?$/i;

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

// markets: [{ id, title, url, volume, endDate, binary, outcomes: [{ label, yes }] }]
export function computeAhead(db, { now = Date.now(), markets = [] } = {}) {
  const today = utcDay(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const rows = db.prepare(`SELECT title, url, source, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type IN ('article', 'post') AND published_at >= ? AND published_at <= ? AND hidden = 0 AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(now - LOOKBACK_DAYS * DAY, now + 5 * 60e3);
  const items = [];
  let scanned = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet((r.title || '').replace(/^\[[^\]]{1,30}\]\s*/, ''));
    if (!title || title.length > 200 || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(title) || NOT.test(title) || !isAiRelated(title.replace(/\bAGI\b/gi, ''))) continue;
    const dates = datesIn(title, r.at);
    if (!dates.length) continue;
    scanned++;
    // The most precise future date the headline names.
    const rank = { day: 0, week: 1, month: 2, quarter: 3 };
    const d = dates
      .filter((x) => Date.parse(x.date) >= today - (x.precision === 'day' ? 0 : x.precision === 'week' ? 6 * DAY : 30 * DAY) && Date.parse(x.date) <= today + AHEAD_DAYS * DAY)
      .sort((a, b) => rank[a.precision] - rank[b.precision])[0];
    if (!d) continue;
    const kind = KINDS.find(([, , re]) => re.test(title))?.[0] || 'launch';
    const source = outlet || r.source || '';
    const toks = new Set(tokens(title));
    const same = items.find((x) => x.date === d.date && x.precision === d.precision && overlap(toks, x.toks) >= 0.4);
    if (same) {
      same.outlets.add(source);
      for (const t of toks) same.toks.add(t);
      if (!same.reports.some((x) => overlap(toks, new Set(tokens(x.title))) >= 0.8)) same.reports.push({ title, url: r.url, source, at: r.at });
      continue;
    }
    items.push({ date: d.date, precision: d.precision, kind, title, url: r.url, source, at: r.at, toks, outlets: new Set([source]), reports: [{ title, url: r.url, source, at: r.at }] });
  }

  const out = items.map((x) => ({
    id: `${x.date}-${[...x.toks].slice(0, 3).join('-')}`.replace(/[^a-z0-9-]/gi, '').slice(0, 60),
    date: x.date,
    precision: x.precision,
    kind: x.kind,
    title: x.title,
    url: x.url,
    source: x.source,
    reported: x.at,
    outlets: x.outlets.size,
    reports: x.reports.slice(0, 6),
  }));

  // Markets close in New York time; "2027-01-01T04:59Z" is December 31.
  const byDay = new Map();
  for (const m of markets) {
    if (!m.endDate) continue;
    const end = Date.parse(m.endDate) - 6 * 3600e3;
    if (!(end >= today && end <= today + 120 * DAY)) continue;
    const date = iso(end);
    const lead = [...(m.outcomes || [])].sort((a, b) => (b.yes || 0) - (a.yes || 0))[0];
    const list = byDay.get(date) || [];
    list.push({ title: m.title, url: m.url, volume: m.volume || 0, binary: !!m.binary, lead: lead ? { label: m.binary ? 'Yes' : lead.label, yes: lead.yes } : null });
    byDay.set(date, list);
  }
  for (const [date, list] of byDay) {
    list.sort((a, b) => b.volume - a.volume);
    out.push({ id: `${date}-markets`, date, precision: 'day', kind: 'market', title: list.length === 1 ? list[0].title : `${list.length} prediction markets close`, url: list[0].url, source: 'Polymarket', outlets: 0, markets: list.slice(0, 8), marketCount: list.length, reports: [] });
  }
  // On one date the loosest come first, so the agenda's headings stay together.
  const loose = { quarter: 0, month: 1, week: 2, day: 3 };
  out.sort((a, b) => a.date.localeCompare(b.date) || loose[a.precision] - loose[b.precision] || (a.kind === 'market') - (b.kind === 'market') || b.outlets - a.outlets);
  const in30 = out.filter((x) => Date.parse(x.date) <= today + 30 * DAY);
  return {
    generatedAt: now,
    today: iso(today),
    lookback: LOOKBACK_DAYS,
    scanned,
    items: out,
    kinds: [...KINDS.map(([k]) => k), 'market'].map((key) => ({ key, label: KIND_LABEL[key], n: out.filter((x) => x.kind === key).length })),
    stats: {
      items: out.filter((x) => x.kind !== 'market').length,
      next30: in30.filter((x) => x.kind !== 'market').length,
      retire: out.filter((x) => x.kind === 'retire').length,
      markets30: in30.filter((x) => x.kind === 'market').reduce((a, x) => a + x.marketCount, 0),
    },
  };
}

export const aheadQuery = (markets) => cachedJob('ahead', { kind: 'ahead', markets }, TTL_MS);

// iCalendar: all-day events for dates known to the day.
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line) => line.match(/.{1,73}/g).join('\r\n ');
export function aheadIcs(d, { ids = null, name = 'Frontier Wire: what’s coming', origin = '' } = {}) {
  const stamp = new Date(d.generatedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Frontier Wire//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(name)}`];
  for (const x of d.items) {
    if (x.precision !== 'day' || (ids && !ids.has(x.id))) continue;
    const start = x.date.replace(/-/g, '');
    const end = iso(Date.parse(x.date) + DAY).replace(/-/g, '');
    const desc = x.kind === 'market' ? x.markets.map((m) => `${m.title}${m.lead ? ` (${m.lead.label} ${Math.round(m.lead.yes * 100)}%)` : ''}`).join('\n') : `${x.source}${x.outlets > 1 ? ` and ${x.outlets - 1} more` : ''}\n${x.url}`;
    lines.push('BEGIN:VEVENT', `UID:${x.id}@frontier-wire`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, fold(`SUMMARY:${icsText(x.title)}`), fold(`DESCRIPTION:${icsText(desc)}`), fold(`URL:${x.url || `${origin}/#ahead`}`), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
