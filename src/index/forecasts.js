// Predictions: what people and firms say will happen, and by when. Reads
// article bodies for sentences that put a claim about the future on a year —
//   “We will have AGI by 2030,” said Jane Doe.
//   Gartner expects AI spending to reach $2 trillion by 2027.
//   Data center demand will hit 80 GW by 2030, according to McKinsey.
// — and keeps the ones it can pin on someone: a quoted person, the subject
// of a forecasting verb, or "according to". The year is when the claim
// comes due; the same forecast carried by several outlets is grouped.
//
// Like quotes, the worker keeps every forecast in memory and only reads
// articles added since the last pass.

import { isAiRelated } from '../pipeline/classify.js';
import { tokens } from '../pipeline/text.js';
import { cachedJob } from './offload.js';
import { extractQuotes, personKey, personName } from './quotes.js';

const DAY = 86400e3;
export const WINDOW_DAYS = 120;
const EN = "(lang IS NULL OR lang = '' OR lang LIKE 'en%')";
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, a: 1 };

// When: a year, a "within N years", a "by the end of the decade".
const HORIZON = /\b(?:by|before|until|through|in|around|within|over|come|the\s+year)\s+(?:the\s+(?:end|middle|start|beginning)\s+of\s+|(?:early|mid|late)[- ]|(?:the\s+)?(?:first|second|third|fourth)\s+(?:half|quarter)\s+of\s+)?(20[2-5]\d)\b|\bwithin\s+(?:the\s+next\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|a|\d{1,2})\s+years?\b|\b(?:in|within|over)\s+(?:the\s+)?next\s+(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|\d{1,2})\s+years\b|\bby\s+the\s+end\s+of\s+(?:the|this)\s+decade\b|\bby\s+(20[2-5]\d)s\b/i;
// A claim about the future, not a report of the past.
const FUTURE = /\b(?:will|won['’]t|would|could|should|may|might|expects?|expected|predicts?|predicted|predicting|forecasts?|forecasted|projects?|projected|projecting|estimates?|estimated|anticipates?|anticipated|on\s+track\s+to|set\s+to|poised\s+to|likely\s+to|going\s+to|aims?\s+to|plans?\s+to|targets?|is\s+to|are\s+to)\b/i;
// Past-tense reporting about that year ("in 2025 revenue grew") and plain schedules aren't forecasts.
const NOT_CLAIM = /\b(?:was|were|had|did|grew|rose|fell|reported|earlier this year|last year|since)\b[^.]{0,40}\b20[2-5]\d\b|\b(?:fiscal|FY)\s*20\d\d\b|\b(?:founded|launched|released|established|published|filed|signed)\s+in\s+20\d\d\b|\bconference\b|\bsummit\b|\bevent\b|\bdeadline to apply\b|\btickets?\b/i;
// "Gartner expects…", "McKinsey estimates…", "Sam Altman predicted…".
const FORECAST_VERB = '(?:plans?|aims?|intends?|hopes?|expects?|expected|predicts?|predicted|forecasts?|forecasted|projects?|projected|estimates?|estimated|anticipates?|believes?|thinks?|says?|said|warns?|warned|argues?|argued|claims?|claimed|told)';
const SUBJECT = new RegExp(`^(?:(?:But|And|Meanwhile|Now|Still),?\\s+)?((?:[A-Z][\\w&.'’-]*|of|de|and|&)(?:\\s(?:[A-Z][\\w&.'’-]*|of|de|and|&)){0,5})(?:,\\s*([^,]{3,80}),)?\\s+(?:now\\s+|also\\s+|still\\s+)?${FORECAST_VERB}\\b`);
const ACCORDING = /\baccording\s+to\s+(?:a\s+(?:new\s+)?(?:report|forecast|study|analysis|survey)\s+(?:from|by)\s+)?((?:[A-Z][\w&.'’-]*)(?:\s(?:[A-Z][\w&.'’-]*|of|and|&)){0,4})/;
const LEAD_IN = /^(?:(?:[A-Z][a-z]+ing|Does|Do|Did|Close|Other|An|Why|How|What|Where|Which|Here|Inside|Meet|More|Less|Big|New|Read|See|Also|Related|Watch|Listen)\s+)+(?=[A-Z])/;
const NOT_WHO = /^(?:The|This|That|These|Those|It|He|She|They|We|I|You|Our|His|Her|Their|Its|Some|Many|Most|Others|Analysts|Experts|Researchers|Investors|Executives|Officials|Sources|People|AI|If|When|While|As|In|On|By|At|For|After|Before|Now|But|And|So|Yet|Still|According|No|Management|Traders|Customers|Users|Companies|Economists|Critics|Proponents|Supporters|Scientists|Engineers|Employers|Workers|Consumers|Lawmakers|Regulators|Developers|Authorities|Observers|Insiders|Estimates|Forecasts|Projections|Reports|Studies|Surveys|Leaders|Industry|Wall|Markets?|Shares|Revenue|Sales|Demand|Spending|Data|Global|Worldwide|Total|A|An|Its|Their)$/;

// Themes, first match wins; each is a few words a reader would filter by.
export const THEMES = [
  { key: 'agi', label: 'AGI', re: /\b(?:AGI|superintelligen\w+|artificial general intelligence|human-level|smarter than (?:humans|people)|surpass(?:es)? human)/i },
  { key: 'jobs', label: 'Jobs', re: /\b(?:jobs?|workers?|workforce|employment|unemployment|layoffs?|labor|labour|white-collar|entry-level|hiring)\b/i },
  { key: 'energy', label: 'Compute & power', re: /\b(?:gigawatts?|GW|megawatts?|power|electricity|energy|data cent(?:er|re)s?|compute|grid|nuclear)\b/i },
  { key: 'chips', label: 'Chips', re: /\b(?:chips?|semiconductors?|GPUs?|wafers?|fabs?|TSMC|HBM|memory)\b/i },
  { key: 'robots', label: 'Robots & cars', re: /\b(?:robots?|robotics|humanoids?|robotaxis?|self-driving|autonomous vehicles?|driverless)\b/i },
  { key: 'adoption', label: 'Adoption', re: /\b(?:agents?|agentic|enterprises?|organi[sz]ations|adopt\w*|businesses|companies will|customers|users|consumers)\b/i },
  { key: 'money', label: 'Money', re: /\b(?:revenue|market|spending|capex|investment|valuation|trillion|billion|profit|GDP|economy|sales)\b/i },
];
const themeOf = (text) => THEMES.find((t) => t.re.test(text))?.key || 'other';

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const sentencesOf = (para) => para.split(/(?<=[.!?][”"]?)\s+(?=[A-Z“"])/);

// The year a horizon points at, from the year the piece was published.
export function targetYear(sentence, pubYear) {
  const m = sentence.match(HORIZON);
  if (!m) return null;
  let year = null;
  if (m[1]) year = Number(m[1]);
  else if (m[2] || m[3]) {
    const w = (m[2] || m[3]).toLowerCase();
    const n = NUM[w] ?? Number(w);
    if (!n) return null;
    year = pubYear + n;
  } else if (m[4]) year = Number(m[4]) + 9;
  else year = Math.floor(pubYear / 10) * 10 + 9; // the end of this decade
  if (year < pubYear || year > pubYear + 30) return null;
  return { year, phrase: m[0] };
}

// Who a sentence's claim belongs to: its subject, or "according to".
export function whoOf(sentence) {
  const a = sentence.match(ACCORDING);
  const s = a ? null : sentence.match(SUBJECT);
  // Bodies sometimes lose the space after a full stop ("Goldman Sachs.As").
  let raw = (a ? a[1] : s?.[1])?.replace(/\.(?:[A-Z][a-z]*)?$|\.(?=[A-Z][a-z]).*$/, '');
  if (!raw || raw.length < 2) return null;
  // A heading run into the sentence ("Leveraging OpenAI expects…").
  raw = raw.replace(LEAD_IN, '');
  const first = raw.split(' ')[0];
  if (NOT_WHO.test(first)) return null;
  const words = raw.replace(/\s+(?:of|and|&)$/, '').split(' ');
  if (words.length > 5) return null;
  // People get their role stripped and a key shared with the quote pages.
  const p = personName(raw);
  if (p && p.name.split(' ').length >= 2 && !/\b(?:Inc|Group|Research|Capital|Partners|Bank|Sachs|Stanley|Securities|Analytics|Intelligence|Institute|Agency|Fund|Association|Council|Index|Global|Insights|Report)\b/.test(p.name)) {
    return { name: p.name, person: true, role: p.role || (s?.[2] && ROLE_AFTER.test(s[2]) ? clean(s[2]) : null) };
  }
  if (!/^[A-Z]/.test(raw)) return null;
  return { name: clean(raw.replace(/['’]s$/, '')), person: false, role: null };
}

const YEARISH = /\b20[2-5]\d|\byears?\b|\bdecade\b/;
const ROLE_AFTER = /\b(?:CEO|founder|chief|president|head|director|analyst|professor)\b/i;
// "Musk expects…" names the person the piece introduced earlier as Elon Musk.
function fullName(text, surname) {
  const m = text.match(new RegExp(`\\b([A-Z][a-z]+(?:\\s[A-Z]\\.)?)\\s${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  if (!m || LEAD_IN.test(`${m[1]} X`) || NOT_WHO.test(m[1])) return null;
  const p = personName(`${m[1]} ${surname}`);
  return p && p.name.includes(' ') ? p.name : null;
}

// Plans are what the speaker itself will do ("OpenAI expects to ship…");
// forecasts are about the world.
const PLAN = /\b(?:plans?|aims?|expects?|intends?|hopes?|is\s+set|are\s+set|is\s+on\s+track|targets?)\s+to\b|\bwill\s+(?:launch|ship|release|open|start|begin|deliver|deploy|bring|build|invest|spend|hire|close|complete|reach\s+\$)/i;

// Every forecast pinned on someone in one article body.
export function extractForecasts(body, at) {
  const pubYear = new Date(at).getUTCFullYear();
  const text = String(body || '');
  // Only paragraphs that name a year or a span of years can hold one; the
  // horizon pattern is costly to try on everything else.
  const paras = text.split('\n').filter((p) => p.length >= 60 && YEARISH.test(p) && HORIZON.test(p));
  if (!paras.length) return [];
  const out = [];
  const seen = new Set();
  const add = (s, who, quoted, t) => {
    const k = s.slice(0, 60);
    if (seen.has(k)) return;
    seen.add(k);
    const kind = !quoted && !who.person && PLAN.test(s) ? 'plan' : 'forecast';
    out.push({ text: clean(s), quoted, name: who.name, person: who.person, role: who.role || null, year: t.year, phrase: t.phrase, kind });
  };
  // Quoted forecasts first: the speaker is known.
  if (paras.some((p) => /[“"]/.test(p))) {
    for (const q of extractQuotes(text)) {
      if (!YEARISH.test(q.text)) continue;
      for (const s of sentencesOf(q.text)) {
        const t = targetYear(s, pubYear);
        if (t && s.length >= 40 && FUTURE.test(s) && !NOT_CLAIM.test(s)) add(s, { name: q.name, person: true, role: q.role }, true, t);
      }
    }
  }
  for (const para of paras) {
    for (const s of sentencesOf(para)) {
      if (s.length < 50 || s.length > 420 || /[“”"]/.test(s)) continue;
      const t = targetYear(s, pubYear);
      if (!t || !FUTURE.test(s) || NOT_CLAIM.test(s)) continue;
      let who = whoOf(s);
      if (!who) continue;
      if (!who.name.includes(' ')) {
        const full = fullName(text, who.name);
        if (full) who = { name: full, person: true, role: null };
      }
      add(s, who, false, t);
    }
  }
  return out;
}

export const whoKey = (name) => personKey(name);
const lineKey = (text) => tokens(text).slice(0, 12).join(' ');

// ---- Worker side ----

export function createForecastIndex() {
  return { lastId: 0, items: [], at: 0 };
}

export function refreshForecasts(db, idx, { now = Date.now(), days = WINDOW_DAYS } = {}) {
  const since = now - days * DAY;
  const top = idx.lastId ? 0 : db.prepare('SELECT MAX(id) AS n FROM docs').get().n || 0;
  const cols = 'id, url, title, description, body, site, source, published_at AS at';
  // Same plans as the quote index: by date first, then by id.
  const rows = idx.lastId
    ? db.prepare(`SELECT ${cols} FROM docs WHERE id > ? AND +type = 'article' AND +hidden = 0 AND +published_at >= ? AND +published_at <= ? AND ${EN} AND length(body) > 400`).all(idx.lastId, since, now + 3600e3)
    : db.prepare(`SELECT ${cols} FROM docs WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND +hidden = 0 AND ${EN} AND length(body) > 400`).all(since, now + 3600e3);
  idx.lastId = Math.max(idx.lastId, top);
  for (const r of rows) {
    idx.lastId = Math.max(idx.lastId, r.id);
    if (!isAiRelated(`${r.title} ${r.description || ''}`)) continue;
    for (const f of extractForecasts(r.body, r.at)) {
      idx.items.push({ ...f, key: whoKey(f.name), line: lineKey(f.text), theme: themeOf(f.text), doc: r.id, url: r.url, title: r.title, site: r.site, source: r.source || r.site, at: r.at });
    }
  }
  if (rows.length) idx.items.sort((a, b) => a.at - b.at);
  idx.items = idx.items.filter((x) => x.at >= since);
  idx.at = now;
  return idx;
}

let shared = null;
export function forecastIndex(db) {
  shared ||= createForecastIndex();
  if (Date.now() - shared.at > 5 * 60e3) refreshForecasts(db, shared);
  return shared;
}

// One entry per forecast, with every outlet that carried it.
function group(items) {
  const out = new Map();
  for (const x of items) {
    const k = `${x.key}|${x.line}`;
    let g = out.get(k);
    if (!g) out.set(k, (g = { text: x.text, phrase: x.phrase, name: x.name, key: x.key, person: x.person, role: x.role, quoted: x.quoted, kind: x.kind, year: x.year, theme: x.theme, first: x, sites: new Set(), copies: [] }));
    if (!g.role && x.role) g.role = x.role;
    if (x.at < g.first.at) g.first = x;
    if (!g.sites.has(x.site)) g.copies.push({ url: x.url, title: x.title, source: x.source, at: x.at });
    g.sites.add(x.site);
  }
  return [...out.values()].map(({ first, sites, copies, ...g }) => ({
    ...g,
    at: first.at,
    url: first.url,
    title: first.title,
    source: first.source,
    outlets: sites.size,
    copies: copies.sort((a, b) => a.at - b.at).slice(0, 6),
  }));
}

// The ledger: forecasts by the year they come due, filtered by theme, year
// or who; counts per year and theme for the chart and chips.
export function computeForecasts(idx, { now = Date.now(), theme = '', year = 0, who = '', limit = 80 } = {}) {
  const all = group(idx.items);
  const thisYear = new Date(now).getUTCFullYear();
  const pick = all.filter((f) => (!theme || f.theme === theme) && (!who || f.key === who));
  const years = new Map();
  for (const f of pick) years.set(f.year, (years.get(f.year) || 0) + 1);
  const themes = new Map();
  for (const f of all) if (!who || f.key === who) themes.set(f.theme, (themes.get(f.theme) || 0) + 1);
  const byWho = new Map();
  for (const f of pick) {
    const w = byWho.get(f.key) || { key: f.key, name: f.name, person: f.person, role: f.role, n: 0, years: new Set() };
    w.n++;
    w.years.add(f.year);
    if (!w.role && f.role) w.role = f.role;
    byWho.set(f.key, w);
  }
  const rank = (a, b) => b.outlets - a.outlets || b.at - a.at;
  // A few per forecaster, unless one is asked for: Gartner alone would fill the page.
  const per = new Map();
  const list = pick.filter((f) => !year || f.year === year).sort(rank)
    .filter((f) => who || (per.set(f.key, (per.get(f.key) || 0) + 1), per.get(f.key) <= 3));
  const span = [...years.keys()];
  return {
    generatedAt: now,
    days: WINDOW_DAYS,
    thisYear,
    theme,
    year,
    who,
    totals: { forecasts: pick.length, who: byWho.size, outlets: new Set(idx.items.map((x) => x.site)).size },
    themes: THEMES.map((t) => ({ key: t.key, label: t.label, n: themes.get(t.key) || 0 })).concat([{ key: 'other', label: 'Other', n: themes.get('other') || 0 }]),
    years: span.length ? Array.from({ length: Math.max(...span) - Math.min(thisYear, ...span) + 1 }, (_, i) => Math.min(thisYear, ...span) + i).map((y) => ({ year: y, n: years.get(y) || 0 })) : [],
    // Coming due: this year and next, the most carried first.
    due: year ? [] : pick.filter((f) => f.year <= thisYear + 1).sort((a, b) => a.year - b.year || rank(a, b)).slice(0, 6),
    who_: [...byWho.values()].filter((w) => w.n >= 2).sort((a, b) => b.n - a.n).slice(0, 16).map((w) => ({ ...w, years: [...w.years].sort() })),
    forecasts: list.slice(0, limit),
  };
}

// ---- Server side ----

const TTL = 10 * 60e3;
export const forecastsQuery = ({ theme = '', year = 0, who = '' } = {}) =>
  cachedJob(`forecasts:${theme}:${year}:${who}`, { kind: 'forecasts', theme, year, who }, TTL);
