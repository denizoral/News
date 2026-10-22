// Rumor tracker: what was reported before it was announced, and whether it
// came true. A hedged headline ("reportedly", "in talks", "sources say",
// "weighs a sale") about a known lab, company or person is a claim; hedged
// headlines a few days apart that share a name and most of their words are the
// same claim carried by more outlets. Later, unhedged coverage of the same
// name and the same particulars settles it: "announces", "closes", "confirms"
// make it confirmed, "denies" or "no plans" make it denied. A claim nobody
// followed up within three weeks went quiet.
//
// From that ledger: how often rumors come true, how far ahead of the
// announcement they ran, and which outlets' scoops tend to hold up.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { nameMatcher, scanWindow } from './graph.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
export const RUMOR_DAYS = 90;
export const QUIET_DAYS = 21;

export const HEDGE = new RegExp([
  String.raw`\breportedly\b`,
  String.raw`^report\s*[:|-]`,
  String.raw`\breports? (?:says?|that)\b`,
  String.raw`\bin (?:early |advanced |final |preliminary )?(?:talks|discussions|negotiations)\b`,
  String.raw`\bsources? (?:say|said|tell|told)\b`,
  String.raw`\b(?:is|are|was|were) said to\b`,
  String.raw`\bpeople (?:familiar|close|with knowledge)\b`,
  String.raw`\baccording to (?:a |the )?(?:report|people|sources|insiders|a person)\b`,
  String.raw`\bnears? (?:a |an )?(?:deal|agreement|acquisition|funding)\b`,
  String.raw`\b(?:weighs|weighing|mulls|mulling|considers|considering)\b(?! in\b)`,
  String.raw`\b(?:eyes|eyeing)\b(?:\s+\S+){0,3}?\s+(?:[$€£]|stake|ipo|deal|acquisition|valuation|bid|merger|listing|funding|raise|round|purchase|takeover|entry|move|launch|expansion|sale|buy)`,
  String.raw`\b(?:close to|on the verge of) (?:a |an )?(?:deal|raising|closing|agreement|acquir|buying|signing)`,
  String.raw`\bexplor(?:es|ing) (?:a |an |the )?(?:possible |potential )?(?:sale|deal|merger|acquisition|ipo|bid|options|raising|funding|partnership|investment|listing|spin)`,
  String.raw`\brumou?r(?:s|ed)?\b`,
  String.raw`\btipped (?:to|for)\b`,
  String.raw`\bin line to\b`,
  String.raw`\b(?:could|may) soon\b`,
].join('|'), 'i');

const DENY = /\b(?:denies|denied|deny|refutes?|rejects? (?:the )?reports?|dismisses|no plans|not in talks|isn'?t (?:in talks|for sale|raising)|calls? (?:the )?reports? (?:false|untrue|inaccurate)|false reports?|walks? away|talks (?:collapse|end|stall|break down)|called off|scraps?|abandons?)\b/i;
// An announcement settles a claim on its own; a plain statement of fact
// ("DeepSeek raises $15B") needs two outlets saying it without hedging.
const CONFIRM = /\b(?:confirms?|confirmed|announces?|announced|officially|unveils?|unveiled|launch(?:es|ed)?|closes?|closed|completes?|completed|finali[sz]es?|finali[sz]ed|signs?|signed|files? for|filed for|goes public|now available|rolls? out|introduces?|appoints?)\b/i;
const FACT = /\b(?:agrees? to|agreed|strikes?|struck|raises?|raised|secures?|secured|lands?|acquires?|acquired|buys|bought|releases?|released|debuts?|takes? (?:a )?stake|invests?|invested|backs|hires|hired|names|named|picks|cuts|lays off|ends|kills|drops)\b/i;
// Still a forecast, not a settlement.
const SPECULATIVE = /\b(?:may|might|could|would|set to|poised to|close to|racing to|races to|aims? to|seeks?|seeking|plans?|planning|expect\w*|likely|ahead of|as early as|reportedly|rumou?r\w*|how to watch|live ?blog)\b|(?<!agrees? |agreed |votes? |voted )\bto (?:file|launch|buy|acquire|raise|release|unveil|announce|go public|list|sell)\b|\?/i;
// Roundups and newsletters mention everything; they neither start nor settle a claim.
const ROUNDUP = /\b(?:daily|weekly|roundup|recap|newsletter|digest|this week|podcast|import ai \d+|episode)\b|\b(?:october|november|december|january|february|march|april|may|june|july|august|september) \d{1,2},? \d{4}\b/i;

const STOP = new Set(('says said new just now will can its with from that this about after over into more your how why what who are has have the and for you not but out all get got one use using used ' +
  'ai report reports reportedly update week today first amid via per gets set like make makes made way big time year next still than may could would should soon ' +
  'here top best inc company companies news latest plans plan ceo boss chief vs talks discussions negotiations sources source people familiar according weighs weighing ' +
  'mulls considers considering eyes eyeing exploring explores rumor rumors rumour rumours exclusive scoop deal deals possible potential early advanced line tipped ' +
  'confirms confirmed announces announced officially denies denied report: comments say tell told nears near advanced over').split(' '));

// Words for the same move, so "acquire" and "buy" match.
const SAME = { acquire: 'buy', acquir: 'buy', acquisition: 'buy', purchase: 'buy', purchas: 'buy', takeover: 'buy', bought: 'buy', fundrais: 'raise', fundraise: 'raise', funding: 'raise', rais: 'raise', ipo: 'listing', list: 'listing', public: 'listing', discontinu: 'end', kill: 'end', cancel: 'end', scrap: 'end' };

const UNIT = { b: 'b', bn: 'b', billion: 'b', m: 'm', mn: 'm', million: 'm', t: 't', tn: 't', trillion: 't' };

// "$15B", "$15 billion" and "15bn" are one token, so amounts can match.
export function amounts(text) {
  const out = [];
  for (const m of text.matchAll(/([$€£])\s?(\d+(?:[.,]\d+)?)\s?(billion|million|trillion|bn|mn|tn|b|m|t)\b/gi)) out.push(`${m[1]}${m[2].replace(',', '.')}${UNIT[m[3].toLowerCase()]}`);
  return out;
}

export function claimWords(title, exclude = new Set()) {
  const money = amounts(title);
  const words = tokens(title.replace(/([$€£])\s?\d+(?:[.,]\d+)?\s?(?:billion|million|trillion|bn|mn|tn|b|m|t)\b/gi, ' '))
    .map((w) => w.replace(/\.$/, ''))
    .filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w) && !exclude.has(w) && !/^\d{1,2}$/.test(w))
    .map((w) => w.replace(/(?:ing|ed|es|s)$/, '') || w)
    .map((w) => SAME[w] || w);
  return new Set([...words, ...money]);
}

const overlap = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

const isHedged = (title) => HEDGE.test(title);
const bare = (title) => splitOutlet(title.replace(/\s+\|\s+[^|]{2,40}$/, '')).title;

// Cosine similarity of two stored articles by URL, from the embedding index
// (the history worker passes one in); null when either isn't embedded.
export function urlSimilarity(db, index) {
  const id = db.prepare('SELECT id FROM docs WHERE url = ?');
  const row = (url) => {
    const r = id.get(url);
    return r ? index.rowOf(r.id) : null;
  };
  return (a, b) => {
    const i = row(a), j = row(b);
    return i == null || j == null ? null : index.dot(i, j);
  };
}

// A settling headline must be at least this close in meaning to the claim.
export const SAME_STORY = 0.76;
// Two hedged headlines this close are the same claim.
export const SAME_CLAIM = 0.84;

export function computeRumors(db, { now = Date.now(), days = RUMOR_DAYS, similar = null } = {}) {
  const scan = scanWindow(db, days, now);
  const since = now - days * DAY;
  const docs = scan.docs.filter((d) => d.at >= since).sort((x, y) => x.at - y.at);
  const namesIn = nameMatcher(scan.nodes);
  const aliasWords = (i) => new Set([scan.nodes[i].label, ...scan.nodes[i].aliases].flatMap((s) => tokens(s)));
  const nameWords = new Map();
  const excl = (names) => {
    const s = new Set();
    for (const i of names) {
      if (!nameWords.has(i)) nameWords.set(i, aliasWords(i));
      for (const w of nameWords.get(i)) s.add(w);
    }
    return s;
  };
  for (const d of docs) {
    const t = bare(d.title);
    d.roundup = ROUNDUP.test(t);
    d.hedged = isHedged(t);
    d.words = claimWords(t, excl(d.names));
    d.money = new Set(amounts(t));
  }

  // Hedged headlines become claims; one that shares a name and most of its
  // particulars with a claim from the last week joins it.
  const claims = [];
  for (const d of docs) {
    if (!d.hedged || d.roundup || d.words.size < (d.names.length >= 2 ? 1 : 2)) continue;
    let best = null;
    let bestScore = 0;
    for (let k = claims.length - 1; k >= 0; k--) {
      const c = claims[k];
      if (d.at - c.last > 7 * DAY) continue;
      if (!d.names.some((i) => c.names.has(i))) continue;
      const o = overlap(d.words, c.words);
      // The same amount about the same name is the same story told twice,
      // and so is the same name told in other words.
      const sim = similar?.(c.docs[0].url, d.url) ?? 0;
      const score = o / Math.min(d.words.size, c.core.size) + (overlap(d.money, c.money) ? 0.5 : 0) + (sim >= SAME_CLAIM ? 1 : 0);
      // Two of the same names and the same move ("Nvidia ... buy ... Hugging Face").
      const pair = d.names.filter((i) => c.names.has(i)).length >= 2 && o >= 1;
      if (((o >= 2 && score >= 0.5) || pair || overlap(d.money, c.money) || sim >= SAME_CLAIM) && score > bestScore) { best = c; bestScore = score; }
    }
    if (best) {
      best.docs.push(d);
      best.last = d.at;
      for (const w of d.words) best.words.add(w);
      for (const m of d.money) best.money.add(m);
      for (const i of d.names) best.names.add(i);
    } else {
      claims.push({ docs: [d], first: d.at, last: d.at, names: new Set(d.names), words: new Set(d.words), core: d.words, money: new Set(d.money) });
    }
  }

  // Settle each claim with later, unhedged coverage of the same particulars.
  const byName = new Map();
  for (const d of docs) if (!d.hedged && !d.roundup) for (const i of d.names) (byName.get(i) || byName.set(i, []).get(i)).push(d);
  const out = [];
  for (const c of claims) {
    const lead = c.docs[0];
    // The claim is about the first name in its headline ("Nvidia weighs a
    // guarantee for OpenAI" is Nvidia's move); a settlement must name it too.
    const subject = namesIn(bare(lead.title))[0] ?? lead.names[0];
    const sources = [...new Set(c.docs.map((d) => d.source))];
    let confirm = null;
    let deny = null;
    const facts = [];
    const seen = new Set();
    for (const i of lead.names) {
      for (const d of byName.get(i) || []) {
        if (d.at <= c.first || seen.has(d.url)) continue;
        seen.add(d.url);
        const o = overlap(d.words, c.words);
        // Shared particulars, or the same amount ("$15B"); a month on, it
        // takes more to be sure it's the same thing.
        const money = overlap(d.money, c.money) > 0;
        const need = d.at - c.first > 14 * DAY ? 3 : 2;
        if (!money && (o < need || o / c.core.size < 0.34)) continue;
        const t = bare(d.title);
        if (!namesIn(t).includes(subject)) continue;
        const sim = similar?.(lead.url, d.url);
        if (sim != null && sim < SAME_STORY) continue;
        if (DENY.test(t)) { if (!deny || d.at < deny.at) deny = d; continue; }
        if (SPECULATIVE.test(t)) continue;
        if (CONFIRM.test(t)) { if (!confirm || d.at < confirm.at) confirm = d; }
        else if (FACT.test(t)) facts.push(d);
      }
    }
    // Two outlets stating it as fact settle it at the second one.
    facts.sort((x, y) => x.at - y.at);
    const firstBy = new Map();
    for (const d of facts) if (!firstBy.has(d.source)) firstBy.set(d.source, d);
    const second = [...firstBy.values()][1];
    if (second && (!confirm || second.at < confirm.at)) confirm = [...firstBy.values()][0];
    // Whichever came first settles it.
    let status = 'open';
    let settled = null;
    if (confirm && (!deny || confirm.at < deny.at)) { status = 'confirmed'; settled = confirm; }
    else if (deny) { status = 'denied'; settled = deny; }
    else if (now - c.last > QUIET_DAYS * DAY) status = 'quiet';
    const ref = (d) => d && { title: d.title, url: d.url, source: d.source, at: d.at };
    out.push({
      id: lead.url,
      title: lead.title,
      url: lead.url,
      source: lead.source,
      at: c.first,
      last: c.last,
      outlets: sources.length,
      sources: sources.slice(0, 8),
      names: [...c.names].slice(0, 4).map((i) => ({ key: scan.nodes[i].key, label: scan.nodes[i].label })),
      reports: c.docs.slice(1, 6).map(ref),
      status,
      settled: ref(settled),
      leadDays: settled ? +((settled.at - c.first) / DAY).toFixed(1) : null,
    });
  }

  const resolved = out.filter((c) => c.status !== 'open');
  const confirmed = out.filter((c) => c.status === 'confirmed');
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const BUCKETS = [[0, 1, 'Same day'], [1, 3, '1–3 days'], [3, 7, '3–7 days'], [7, 14, '1–2 weeks'], [14, 30, '2–4 weeks'], [30, Infinity, 'Over a month']];
  const ahead = BUCKETS.map(([lo, hi, label]) => ({ label, n: confirmed.filter((c) => c.leadDays >= lo && c.leadDays < hi).length }));

  // Outlets' track record: of the claims they carried that are settled or
  // went quiet, how many came true.
  const per = new Map();
  for (const c of resolved) {
    for (const s of c.sources) {
      const o = per.get(s) || { name: s, claims: 0, confirmed: 0, denied: 0, quiet: 0, firstOn: 0, lead: [] };
      o.claims++;
      o[c.status]++;
      if (s === c.source) o.firstOn++;
      if (c.status === 'confirmed') o.lead.push(c.leadDays);
      per.set(s, o);
    }
  }
  const outlets = [...per.values()]
    .filter((o) => o.claims >= 3)
    .map(({ lead, ...o }) => ({ ...o, rate: +(o.confirmed / o.claims).toFixed(3), medianLead: median(lead) }))
    .sort((a, b) => b.claims - a.claims || b.rate - a.rate)
    .slice(0, 16);

  const rank = (c) => c.outlets * 2 + (c.status === 'confirmed' ? 3 : c.status === 'denied' ? 2 : 0) + (c.status === 'open' ? 2 : 0);
  return {
    days,
    since,
    generatedAt: now,
    totals: {
      claims: out.length,
      open: out.filter((c) => c.status === 'open').length,
      confirmed: confirmed.length,
      denied: out.filter((c) => c.status === 'denied').length,
      quiet: out.filter((c) => c.status === 'quiet').length,
      rate: resolved.length ? +(confirmed.length / resolved.length).toFixed(3) : null,
      medianLead: median(confirmed.map((c) => c.leadDays)),
    },
    ahead,
    outlets,
    claims: out.sort((a, b) => b.at - a.at).slice(0, 240).map((c) => ({ ...c, weight: rank(c) })),
  };
}

export const rumorsQuery = () => cachedJob('rumors', { kind: 'rumors' }, TTL_MS);
