// The compute race: a year of AI chip news from headlines. A chip headline
// names silicon (GPUs, TPUs, accelerators, HBM, fabs) and usually a camp:
// Nvidia, AMD, the cloud giants' own chips, Chinese chips, the startups, or
// the memory makers and fabs underneath them all. What happened is one of a
// launch, a deal or order, a shortage, an export control, or money (rounds,
// earnings, valuations). Headlines about the same camp and the same kind of
// news within five days, told the same way, are one event; GPU counts named
// in deals ("100,000 Blackwell GPUs") are pulled out, and each camp's share
// of chip headlines is followed month by month.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { nameBefore } from './deals.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const CHIP_DAYS = 365;

const FTS = 'title:(GPU OR GPUs OR chip OR chips OR chipmaker OR chipmakers OR semiconductor OR semiconductors OR accelerator OR accelerators OR TPU OR TPUs OR Trainium OR Blackwell OR Rubin OR HBM OR Ascend OR Cerebras OR Groq OR "export controls" OR "export control" OR foundry OR wafer OR wafers OR ASIC OR silicon OR H200 OR H20 OR GB300 OR GB200 OR MI450 OR MI355 OR TSMC OR ASML)';

const CHIP = /\bGPUs?\b|\b(?:AI|GPU) servers?\b|\bchips?\b|\bchipmakers?\b|\bsemiconductors?\b|\baccelerators?\b|\bTPUs?\b|\bTrainium\d?\b|\bBlackwell\b|\bRubin\b|\bHBM\d?\w*\b|\bASICs?\b|\bsilicon\b|\bfoundr(?:y|ies)\b|\bwafers?\b|\bH[12]00\b|\bH20\b|\bB[23]00\b|\bGB[23]00\b|\bMI\d{3}\w?\b|\bAscend\b|\bCUDA\b|\bsupercomputers?\b|\bsuperclusters?\b|\bexport controls?\b|\bTSMC\b|\bASML\b|\bCerebras\b|\bGroq\b/i;
// Chip news in name only: stock tips, gaming cards, patents, papers, models,
// listicles, and the many headlines that only mention Nvidia as a partner.
const NOT_CHIPS = /\bstocks? (?:to buy|to watch|could|that|picks?)\b|\bcould be worth\b|\bprice targets?\b|\bbuy (?:the )?dip\b|\bshould you buy\b|\bmotley\b|\b(?:is|are) .* a buy\b|\bpatents?\b|\bPaper page\b|\barXiv\b|\bRTX \d{4}\b|\bDLSS\b|\bgaming\b|\bgamers?\b|\bconsoles?\b|\blaptops?\b|\bsmartphones?\b|\bphones?\b|\biPhone\b|\bPixel\b|\bGalaxy\b|\bESP32\b|\bRaspberry\b|\bNemotron\b|\bhow to\b|\bbest\b|\branked\b|\bweekly\b|\broundup\b|\brecap\b|\bnewsletter\b|\bpodcast\b|\bwebinar\b|\bpotato chips?\b|\bchip in\b|\bchips? away\b|\bchocolate\b|\bpoker\b|\bstock market\b|\?$/i;

// Camps, first named wins.
export const CAMPS = [
  ['nvidia', 'Nvidia', /\bNvidia\b|\bNVIDIA\b|\bBlackwell\b|\bRubin\b|\bGB[23]00\b|\bH[12]00\b|\bH20\b|\bB[23]00\b|\bDGX\b|\bCUDA\b|\bJensen Huang\b|\bVera\b/],
  ['amd', 'AMD', /\bAMD\b|\bInstinct\b|\bMI\d{3}\w?\b|\bLisa Su\b/],
  ['custom', 'Cloud giants’ own chips', /\bTPUs?\b|\bIronwood\b|\bTrainium\d?\b|\bInferentia\b|\bMaia\b|\bMTIA\b|\bcustom (?:AI )?(?:chips?|silicon|ASICs?|accelerators?)\b|\bBroadcom\b|\bMarvell\b|\bin-house chips?\b|\bown (?:AI )?chips?\b/],
  ['china', 'Chinese chips', /\bHuawei\b|\bAscend\b|\bCambricon\b|\bHygon\b|\bMoore Threads\b|\bBiren\b|\bMetaX\b|\bZhenwu\b|\bKunlun\b|\bSMIC\b|\bChinese (?:AI )?(?:chips?|chipmakers?|GPUs?)\b|\bChina['’]s (?:own )?(?:AI )?chips?\b/],
  ['startups', 'Chip startups', /\bCerebras\b|\bGroq\b|\bSambaNova\b|\bTenstorrent\b|\bEtched\b|\bd-Matrix\b|\bLightmatter\b|\bGraphcore\b|\bPositron\b|\bMatX\b|\bRebellions\b|\bFuriosaAI\b|\bAyar Labs\b/],
  ['supply', 'Memory and fabs', /\bTSMC\b|\bASML\b|\bHBM\d?\w*\b|\bSK [Hh]ynix\b|\bMicron\b|\bSamsung\b|\bIntel\b|\bfoundr(?:y|ies)\b|\bfabs?\b|\bwafers?\b|\bmemory\b|\bDRAM\b|\bNAND\b|\bpackaging\b|\bCoWoS\b/],
];
const CAMP_LABEL = Object.fromEntries(CAMPS.map(([k, l]) => [k, l]));

// What happened, first match wins: export rules outrank everything they touch.
export const KINDS = [
  ['export', 'Export controls', /\bexport (?:controls?|curbs?|ban|bans|rules?|licen[cs]es?|restrictions?|limits?)\b|\bsmuggl\w*|\bEntity List\b|\bchip (?:ban|curbs?|controls?)\b|\bban\w* (?:\S+ ){0,3}(?:sales?|exports?|chips?) to China\b|\bsell(?:ing|s)? (?:\S+ ){0,4}(?:to|in) China\b|\bH20\b|\bH200s? (?:to|for|in) China\b|\btariffs? (?:\S+ ){0,3}(?:chips?|semiconductors?)\b|\bsemiconductor tariffs?\b|\bGAIN AI Act\b|\bAI diffusion rule\b/i],
  ['shortage', 'Shortages and prices', /\bshortages?\b|\bsold out\b|\bsupply (?:crunch|crisis|constraints?|squeeze)\b|\bconstrain\w*|\bcan(?:not|['’]t) (?:fill|meet|keep up)\b|\bbacklog\b|\bwait(?:ing)? lists?\b|\blead times?\b|\bprices? (?:rise|rises|soar\w*|jump\w*|hikes?|increases?|surge\w*)\b|\b\d+% price increases?\b|\bcrisis\b|\brationing\b|\ballocation\b|\bscarc\w*/i],
  ['deal', 'Deals and orders', /\borders?\b|\bbuys?\b|\bbought\b|\bpurchas\w*|\bdeal\b|\bdeals\b|\bagreement\b|\bcontract\b|\bsupply (?:deal|pact)\b|\bsigns?\b|\bpartner\w* (?:to|on|with)\b|\bto deploy\b|\bdeploy\w* (?:\S+ ){0,3}(?:GPUs|chips|TPUs|accelerators)\b|\b\d[\d,.]*\s*(?:million |thousand |k )?(?:\S+ )?(?:GPUs|TPUs|chips|accelerators)\b|\bgigawatts? of\b|\brent\w* (?:\S+ ){0,2}(?:GPUs|TPUs|chips)\b|\bcapacity\b/i],
  ['launch', 'Launches', /\bunveil\w*|\blaunch\w*|\bannounc\w*|\bintroduc\w*|\bdebut\w*|\bships?\b|\bshipping\b|\bnow available\b|\bavailable\b|\broadmap\b|\bnext-gen\w*|\bnew (?:\S+ )?(?:chips?|GPUs?|accelerators?|TPUs?)\b|\btape[sd]? out\b|\btaped out\b|\bspecs?\b|\breveals?\b|\bbenchmarks?\b|\bgenerally available\b|\bin production\b|\bmass production\b/i],
  ['money', 'Money and earnings', /\braises?\b|\braised\b|\bfunding\b|\bvaluation\b|\bvalued\b|\bIPO\b|\bearnings\b|\brevenue\b|\bquarter\b|\bmarket cap\b|\btrillion\b|\bsales\b|\bprofit\w*|\bguidance\b|\bforecast\b|\bshares? (?:rise|fall|jump|drop|soar|slump|surge|plunge|tumble)\w*/i],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));

// "100,000 Blackwell GPUs", "1 million TPUs".
const UNITS = /\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(million|thousand|k|m)?\s+(?:(?:Nvidia|AMD|Blackwell|Rubin|H100|H200|B200|B300|GB200|GB300|Ascend|Trainium\d?|Google|TPU|MI\d{3}\w?|Instinct|more|new|AI|extra|additional)\s+){0,3}(GPUs|TPUs|chips|accelerators|superchips)\b/i;

export function parseChip(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (!CHIP.test(title) || NOT_CHIPS.test(title)) return null;
  const kind = KINDS.find(([, , re]) => re.test(title))?.[0];
  if (!kind) return null;
  let camp = null;
  let first = Infinity;
  for (const [key, , re] of CAMPS) {
    const m = re.exec(title);
    if (m && m.index < first) { first = m.index; camp = key; }
  }
  const camps = CAMPS.filter(([, , re]) => re.test(title)).map(([k]) => k);
  let units = null;
  let buyer = null;
  const u = UNITS.exec(title);
  if (u) {
    const v = Number(u[1].replace(/,/g, '')) * ({ million: 1e6, m: 1e6, thousand: 1e3, k: 1e3 }[u[2]?.toLowerCase()] || 1);
    // A year isn't a count of chips.
    if (v >= 100 && !(/^20[2-4]\d$/.test(u[1]) && !u[2])) {
      units = v;
      const verb = /\b(?:buys?|buying|orders?|to buy|will buy|deploys?|to deploy|rents?|renting|rented|secures?|gets?|lands?|signs?|adds?|adding|plans?|wants?|targets?)\b/i.exec(title);
      if (verb && verb.index < u.index) buyer = nameBefore(title.slice(0, verb.index)) || null;
    }
  }
  return { title, kind, camp, camps, units, buyer };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeChips(db, now = Date.now(), days = CHIP_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);
  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), n: 0, headlines: 0, kinds: Object.fromEntries(KINDS.map(([k]) => [k, 0])), camps: Object.fromEntries(CAMPS.map(([k]) => [k, 0])) });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  const campN = Object.fromEntries(CAMPS.map(([k]) => [k, { n90: 0, prev90: 0 }]));
  let in90 = 0;
  let inPrev = 0;
  const events = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue;
    const p = parseChip(r.title);
    if (!p) continue;
    headlines++;
    // Every chip headline counts toward each camp it names.
    const m = months[mi.get(new Date(r.at).toISOString().slice(0, 7))];
    if (m) {
      m.headlines++;
      for (const c of p.camps) m.camps[c]++;
    }
    const recent = r.at >= now - 90 * DAY;
    const prev = !recent && r.at >= now - 180 * DAY;
    if (recent) in90++;
    if (prev) inPrev++;
    for (const c of p.camps) {
      if (recent) campN[c].n90++;
      if (prev) campN[c].prev90++;
    }
    const source = outlet || r.source || r.site;
    const toks = new Set(tokens(title));
    const same = events.find((x) => x.kind === p.kind && x.camp === p.camp && r.at - x.last < 5 * DAY && overlap(toks, x.toks) >= 0.35);
    if (same) {
      same.last = r.at;
      same.outlets.add(source);
      for (const t of toks) same.toks.add(t);
      if (p.units && (!same.units || p.units > same.units)) { same.units = p.units; same.buyer ||= p.buyer; }
      if (!same.reports.some((x) => overlap(toks, x.toks) >= 0.7)) same.reports.push({ at: r.at, title, url: r.url, source, toks });
      continue;
    }
    events.push({ ...p, at: r.at, last: r.at, url: r.url, source, outlets: new Set([source]), toks, reports: [{ at: r.at, title, url: r.url, source, toks }] });
  }

  // Kept: what two outlets carried, any export rule or GPU count, or a camp's shortage, deal or launch.
  const out = events.filter((x) => x.outlets.size >= 2 || x.kind === 'export' || x.units || (x.camp && x.kind !== 'money')).map((x) => ({
    id: `${x.kind}-${x.camp || 'chips'}-${new Date(x.at).toISOString().slice(0, 10)}-${tokens(x.title).slice(0, 2).join('-')}`.slice(0, 80),
    at: x.at,
    last: x.last,
    kind: x.kind,
    camp: x.camp,
    units: x.units,
    buyer: x.buyer,
    title: x.title,
    url: x.url,
    source: x.source,
    outlets: x.outlets.size,
    reports: x.reports.slice(0, 8).map(({ toks, ...r }) => r),
  })).sort((a, b) => b.at - a.at);
  for (const x of out) {
    const m = months[mi.get(new Date(x.at).toISOString().slice(0, 7))];
    if (m) {
      m.n++;
      m.kinds[x.kind]++;
    }
  }

  const ev90 = out.filter((x) => x.at >= now - 90 * DAY);
  const evPrev = out.filter((x) => x.at < now - 90 * DAY && x.at >= now - 180 * DAY);
  const unitDeals = out.filter((x) => x.units).sort((a, b) => b.units - a.units);
  const camps = CAMPS.map(([key, label]) => ({
    key,
    label,
    n: months.reduce((a, m) => a + m.camps[key], 0),
    n90: campN[key].n90,
    prev90: campN[key].prev90,
    share90: in90 ? campN[key].n90 / in90 : 0,
    sharePrev: inPrev ? campN[key].prev90 / inPrev : 0,
    events: out.filter((x) => x.camp === key).length,
  }));
  return {
    generatedAt: now,
    days,
    headlines,
    events: out.slice(0, 500),
    months,
    kinds: KINDS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.kind === key).length, n90: ev90.filter((x) => x.kind === key).length })),
    camps,
    exports: out.filter((x) => x.kind === 'export').slice(0, 40).map(({ reports, ...x }) => x),
    units: unitDeals.slice(0, 15).map(({ reports, ...x }) => x),
    labels: { kinds: KIND_LABEL, camps: CAMP_LABEL },
    stats: {
      events: out.length,
      n90: ev90.length,
      prev90: evPrev.length,
      export90: ev90.filter((x) => x.kind === 'export').length,
      shortage90: ev90.filter((x) => x.kind === 'shortage').length,
      headlines90: in90,
      biggestOrder: unitDeals[0] ? { title: unitDeals[0].title, url: unitDeals[0].url, units: unitDeals[0].units, buyer: unitDeals[0].buyer, camp: unitDeals[0].camp } : null,
    },
  };
}

export const chipsQuery = () => cachedJob('chips', { kind: 'chips' }, TTL_MS);
