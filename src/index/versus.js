// Head to head: two names from the entity graph's vocabulary (labs, people,
// products, governments) side by side over 7, 30 or 90 days of articles.
// How much coverage each got per day and in all, how much of it was about
// both, which outlets lean to one or the other, the words that set each
// one's headlines apart (weighted log-odds against the shared background,
// so "IPO" shows up for the one going public and not for both), who else
// comes up with each, each one's biggest day, and their deals.
//
// Reuses the graph's window scan (one pass, cached in the history worker),
// so a comparison costs a few milliseconds once the window is warm.

import { tokens } from '../pipeline/text.js';
import { scanWindow, WINDOWS } from './graph.js';
import { companyDeals, companyKey } from './deals.js';
import { centralHeadline } from './day.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 20 * 60e3;
export const VERSUS_WINDOWS = WINDOWS;

const STOP = new Set(('says said new just now will can its with from that this about after over into more your how why what who are has have the and for you not but out all get got one ' +
  'use using used ai report reports update week today first amid via per gets set like make makes made way big time year next still than may could would should ' +
  'here top best inc company companies news latest launches launch announces announced plans plan deal deals ceo boss chief vs versus billion million trillion things people room').split(' '));

const dedupeKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 7).join(' ');

function headlines(docs, limit) {
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const k = dedupeKey(d.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: d.url, title: d.title, source: d.source, site: d.site, at: d.at });
    if (out.length >= limit) break;
  }
  return out;
}

// Words (and two-word phrases) much likelier in one side's headlines than
// the other's: log-odds ratio with an informative Dirichlet prior from the
// whole window (Monroe, Colaresi & Quinn), as a z-score.
export function distinctiveWords(aTitles, bTitles, bgTitles, { exclude = new Set(), limit = 10, min = 3 } = {}) {
  const grams = (t) => {
    const w = tokens(t).filter((x) => (x.length > 2 || /\d/.test(x)) && !STOP.has(x) && !exclude.has(x) && !/^\d+$/.test(x));
    return new Set([...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)]);
  };
  const count = (titles) => {
    const m = new Map();
    let n = 0;
    for (const t of titles) for (const g of grams(t)) { m.set(g, (m.get(g) || 0) + 1); n++; }
    return { m, n };
  };
  const A = count(aTitles);
  const B = count(bTitles);
  const G = count(bgTitles);
  const a0 = Math.min(500, G.n / 4); // prior strength, lighter for a thin window
  const z = new Map();
  for (const g of new Set([...A.m.keys(), ...B.m.keys()])) {
    const ya = A.m.get(g) || 0;
    const yb = B.m.get(g) || 0;
    if (ya + yb < min) continue;
    const ag = (a0 * ((G.m.get(g) || 0) + 1)) / (G.n + G.m.size);
    const la = Math.log((ya + ag) / (A.n + a0 - ya - ag));
    const lb = Math.log((yb + ag) / (B.n + a0 - yb - ag));
    z.set(g, { g, ya, yb, z: (la - lb) / Math.sqrt(1 / (ya + ag) + 1 / (yb + ag)) });
  }
  // Natural case from the headlines ("IPO", "Claude Duet").
  const cased = (g, titles) => {
    const re = new RegExp(`\\b${g.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-]+')}\\b`, 'i');
    for (const t of titles) {
      const m = t.match(re);
      if (m) return m[0];
    }
    return g;
  };
  const pick = (side, titles) => {
    const sorted = [...z.values()].filter((x) => (side > 0 ? x.z > 1.96 && x.ya >= min : x.z < -1.96 && x.yb >= min)).sort((x, y) => side * (y.z - x.z));
    const out = [];
    for (const x of sorted) {
      // A phrase and its own words are one idea; keep the stronger.
      if (out.some((o) => o.g.split(' ').some((w) => x.g.split(' ').includes(w)))) continue;
      out.push(x);
      if (out.length >= limit) break;
    }
    return out.map((x) => ({ word: cased(x.g, titles), n: side > 0 ? x.ya : x.yb, z: +Math.abs(x.z).toFixed(1) }));
  };
  return { a: pick(1, aTitles), b: pick(-1, bTitles) };
}

export function computeVersus(db, { a, b, days = 30, now = Date.now() }) {
  const scan = scanWindow(db, days, now);
  const ia = scan.nodes.findIndex((n) => n.key === a);
  const ib = scan.nodes.findIndex((n) => n.key === b);
  const info = (i) => (({ key, label, type, topic }) => ({ key, label, type, topic }))(scan.nodes[i]);
  // The names worth comparing in this window, for the pickers.
  const totals = new Array(scan.nodes.length).fill(0);
  for (const d of scan.docs) if (d.cur) for (const i of d.names) totals[i]++;
  const names = scan.nodes.map((n, i) => ({ ...info(i), n: totals[i] })).filter((n) => n.n >= 10).sort((x, y) => y.n - x.n).slice(0, 80);
  if (ia < 0 || ib < 0 || ia === ib) return { days, names, a: ia >= 0 ? info(ia) : null, b: ib >= 0 ? info(ib) : null, missing: true };

  const cur = scan.docs.filter((d) => d.cur).sort((x, y) => y.at - x.at);
  const hasA = (d) => d.names.includes(ia);
  const hasB = (d) => d.names.includes(ib);
  const aDocs = cur.filter(hasA);
  const bDocs = cur.filter(hasB);
  const both = aDocs.filter(hasB);
  const prev = { a: 0, b: 0 };
  for (const d of scan.docs) if (!d.cur) { if (hasA(d)) prev.a++; if (hasB(d)) prev.b++; }

  const day = (at) => Math.min(days - 1, Math.max(0, Math.floor((at - scan.since) / DAY)));
  const series = { a: new Array(days).fill(0), b: new Array(days).fill(0), both: new Array(days).fill(0) };
  for (const d of aDocs) series.a[day(d.at)]++;
  for (const d of bDocs) series.b[day(d.at)]++;
  for (const d of both) series.both[day(d.at)]++;

  // Each side's biggest day and what led it.
  const peak = (s, docs) => {
    let i = 0;
    s.forEach((v, k) => { if (v > s[i]) i = k; });
    // The headline most like the rest of that day's (what they all said).
    const lead = centralHeadline(docs.filter((d) => day(d.at) === i).sort((x, y) => x.at - y.at).map((d) => ({ ...d, type: 'article' })));
    return s[i] ? { day: i, at: scan.since + i * DAY, n: s[i], title: lead?.title, url: lead?.url, source: lead?.source } : null;
  };

  // Outlets that wrote about either, and which way they lean.
  const per = new Map();
  for (const d of aDocs) { const o = per.get(d.source) || { a: 0, b: 0 }; o.a++; per.set(d.source, o); }
  for (const d of bDocs) { const o = per.get(d.source) || { a: 0, b: 0 }; o.b++; per.set(d.source, o); }
  const expected = aDocs.length / Math.max(1, aDocs.length + bDocs.length);
  const outlets = [...per]
    .map(([name, o]) => ({ name, a: o.a, b: o.b, total: o.a + o.b, share: +(o.a / (o.a + o.b)).toFixed(3) }))
    .filter((o) => o.total >= Math.max(4, Math.round((aDocs.length + bDocs.length) / 200)))
    .sort((x, y) => y.total - x.total)
    .slice(0, 14);
  for (const o of outlets) o.lean = +(o.share - expected).toFixed(3);

  // Words that set each apart, leaving out the names themselves.
  const exclude = new Set([...scan.nodes[ia].aliases, ...scan.nodes[ib].aliases, scan.nodes[ia].label, scan.nodes[ib].label].flatMap((s) => tokens(s)));
  const words = distinctiveWords(aDocs.filter((d) => !hasB(d)).map((d) => d.title), bDocs.filter((d) => !hasA(d)).map((d) => d.title), cur.map((d) => d.title), { exclude });

  const company = (i) => {
    const n = scan.nodes[i];
    if (n.type !== 'org') return null;
    const d = companyDeals(db, { key: companyKey(n.label), now });
    if (!d) return null;
    const v = d.valuations[d.valuations.length - 1];
    return { raised: d.raised, valuation: v?.valuation || null, valuedAt: v?.at || null, recent: d.deals.slice(-3).reverse().map(({ title, url, at, amount, kind, round, talks }) => ({ title, url, at, amount, kind, round, talks })) };
  };

  const seenWith = (docs, self, other) => {
    const m = new Map();
    for (const d of docs) for (const i of d.names) if (i !== self && i !== other) m.set(i, (m.get(i) || 0) + 1);
    return [...m].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([i, n]) => ({ ...info(i), n, share: +(n / Math.max(1, docs.length)).toFixed(3) }));
  };

  return {
    days,
    since: scan.since,
    generatedAt: now,
    articles: scan.total,
    names,
    a: { ...info(ia), n: aDocs.length, prev: days <= 30 ? prev.a : null, peak: peak(series.a, aDocs), with: seenWith(aDocs, ia, ib), words: words.a, deals: company(ia), headlines: headlines(aDocs.filter((d) => !hasB(d)), 6) },
    b: { ...info(ib), n: bDocs.length, prev: days <= 30 ? prev.b : null, peak: peak(series.b, bDocs), with: seenWith(bDocs, ib, ia), words: words.b, deals: company(ib), headlines: headlines(bDocs.filter((d) => !hasA(d)), 6) },
    both: { n: both.length, headlines: headlines(both, 6) },
    series,
    outlets,
  };
}

export const versusQuery = ({ a, b, days }) => cachedJob(`versus:${days}:${a}:${b}`, { kind: 'versus', a, b, days }, TTL_MS);
