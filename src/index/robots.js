// Robots: the year in robotics from headlines. A robotics headline names a
// company (Figure, Unitree, Tesla's Optimus, Agility…), what happened (money
// raised, a robot unveiled, robots put to work, a production target, a new
// robot brain, or a setback) and often a number: the round, the price tag or
// how many units. Headlines about the same company and the same kind of news
// within a week are one event; companies are placed in the US, China, Europe
// or Japan and Korea so the race between them can be followed month by month.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { parseMoney, nameBefore, companyKey } from './deals.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const ROBOT_DAYS = 365;

const FTS = 'title:(robot OR robots OR robotic OR robotics OR humanoid OR humanoids OR Optimus OR Unitree OR "Boston Dynamics" OR Apptronik OR "Physical Intelligence" OR Skild OR UBTech OR AgiBot OR "Figure AI" OR "Agility Robotics" OR cobot OR cobots OR "physical AI" OR "embodied AI")';

const ROBOT = /\brobots?\b|\brobotic\w*|\bhumanoids?\b|\bOptimus\b|\bUnitree\b|\bBoston Dynamics\b|\bApptronik\b|\bPhysical Intelligence\b|\bSkild\b|\bUBTech\b|\bAgiBot\b|\bFigure AI\b|\bcobots?\b|\bphysical AI\b|\bembodied AI\b/i;
// Robot in name only: robotaxis (on #incidents and elsewhere), robots.txt,
// robocalls, software "robots", research papers, and lists and opinion.
const NOT_ROBOT = /\brobotaxis?\b|\brobo-?taxis?\b|\brobots\.txt\b|\brobocalls?\b|\brobo-?advis\w*|\brobotic process automation\b|\bRPA\b|\bPaper page\b|\barXiv\b|\bpodcast\b|\bwebinar\b|\bnewsletter\b|\bthis week['’]s\b|\bweekly\b|\broundup\b|\brecap\b|\bstocks? to (?:buy|watch)\b|\bETFs?\b|\bshares (?:rise|fall|jump|drop|soar|slump)\b|\bstock (?:rises|falls|jumps|drops|soars)\b|\bhow to\b|\bpatents?\b|\bjob\b|\bhiring\b|\bcourse\b|\bdeals? on\b|\bsale\b|\bBlack Friday\b|\bPrime Day\b|\b% off\b|\boverlords\b|\bwhy (?:we|you)\b|\?$/i;

// What happened, first match wins: a setback outranks the rest, money outranks
// a launch that mentions it.
export const KINDS = [
  ['setback', 'Setbacks', /\bdelays\b|\bdelayed\b|\bpush(?:es|ed)? (?:\S+ ){0,4}(?:to|into) (?:late |early |next )?(?:20\d\d|next year)\b|\bstill a problem\b|\bstruggl\w*|\brecall\w*|\binjur\w*|\bsues?\b|\bsued\b|\blawsuits?\b|\blayoffs?\b|\bcuts? (?:\S+ ){0,2}jobs\b|\bhalt\w*|\bscrap\w*|\bshut(?:s|ting)? down\b|\bbankrupt\w*|\bmeltdown\b|\bstumbl\w*|\bfalls? over\b|\bmalfunction\w*|\bgoes rogue\b|\battack(?:s|ed)\b|\bsafety (?:concerns?|probe|fears?)\b|\bisn['’]t (?:deploying|using)\b|\bfake\b|\bfaked\b|\badmits?\b/i],
  ['funding', 'Money raised', /\braises?\b|\braised\b|\braising\b|\bfunding\b|\bvaluation\b|\bvalued at\b|\bSeries [A-F]\b|\bseed (?:round|funding)\b|\bpre-seed\b|\bIPO\b|\bgoes public\b|\bmarket debut\b|\bstock market debut\b|\blisting\b|\bunicorn\b|\bsecures \$|\blands \$|\bbacks\b|\binvests?\b|\binvestment\b|\bacquir\w*|\bbuys\b|\bmerger\b|\bSPAC\b/i],
  ['production', 'Production', /\bmass[- ]produc\w*|\bproduction\b|\b\d[\d,.]*\s*(?:million |thousand |k )?(?:units|humanoids)\b|\bmanufactur\w* (?:\S+ ){0,2}(?:humanoids?|robots)\b|\brobot factory\b|\bfactory (?:that|to) (?:build|make)s?\b|\bper (?:year|month|day)\b|\bannual capacity\b|\bproduction lines?\b|\bevery (?:ten|\d+) minutes\b/i],
  ['deploy', 'Put to work', /\bdeploy\w*|\bpilot\w*|(?<!pre-?)\borders?\b|\brollout\b|\brolls? out\b|\bcontract\w*|\bcustomers?\b|\bdeliver(?:s|ed|ies)\b|\bships? (?:to|its first)\b|\bfactory floors?\b|\bwarehouses?\b|\bon the job\b|\bat work\b|\bput to work\b|\bsigns?\b|\bagreement\b|\bpartner\w*|\btrials?\b|\bjoins (?:the )?(?:workforce|line)\b|\bhired\b|\bworking (?:at|in)\b|\bshifts?\b/i],
  ['brain', 'Robot brains and data', /\bmodels?\b|\bfoundation\b|\bVLAs?\b|\bvision-language-action\b|\bworld models?\b|\btraining data\b|\bdatasets?\b|\bdata factory\b|\bsimulat\w*|\bsim-to-real\b|\bGemini Robotics\b|\bGR00T\b|\bCosmos\b|\bIsaac\b|\bpolic(?:y|ies)\b|\blearn\w*|\bteach\w*|\btrain\w*|\bbrains?\b|\bopen[- ]source\w*|\breasoning\b|\bplatform\b|\bOS\b|\bsoftware\b/i],
  ['launch', 'Unveiled', /\bunveil\w*|\blaunch\w*|\bintroduc\w*|\breveal\w*|\bdebut\w*|\bpre-?orders?\b|\bpriced?\b|\bcosts?\b|\bon sale\b|\bshows? off\b|\bshowcas\w*|\bdemo\w*|\bnew (?:\S+ )?(?:robot|humanoid)s?\b|\bannounc\w*|\bmeet\b|\bhands-on\b|\bfirst look\b|\bexits stealth\b/i],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));

export const FORMS = [
  ['humanoid', 'Humanoids', /\bhumanoids?\b|\bOptimus\b|\bAtlas\b|\bDigit\b|\bFigure 0?\d\b|\bandroids?\b|\bbipedal\b|\bUnitree [GH]\d\b|\bApollo\b|\bNEO\b|\bWalker S\w*\b/i],
  ['home', 'Home robots', /\bhome robots?\b|\bhousehold\b|\bvacuum\w*|\blawn\b|\bmowers?\b|\bRoomba\b|\bRoborock\b|\bkitchen\b|\blaundry\b|\bchores\b|\bcompanion\b|\bpet robots?\b|\bin (?:your|the) home\b|\bhomes\b/i],
  ['delivery', 'Delivery robots', /\bdelivery robots?\b|\bsidewalk\b|\bStarship\b|\bServe Robotics\b|\bdeliveries\b|\bdelivery\b/i],
  ['medical', 'Medical robots', /\bsurg(?:ery|ical|eons?)\b|\bhospitals?\b|\bmedical\b|\bnursing\b|\bcare robots?\b|\bhealthcare\b|\bpatients?\b/i],
  ['industrial', 'Industrial robots', /\barms?\b|\bcobots?\b|\bwarehouses?\b|\bfactor(?:y|ies)\b|\bindustrial\b|\bmanufactur\w*|\blogistics\b|\bconstruction\b|\bagricultur\w*|\bfarm\w*|\bmining\b|\bassembly\b|\bpackages\b|\bwelding\b/i],
];
const FORM_LABEL = Object.fromEntries([...FORMS.map(([k, l]) => [k, l]), ['other', 'Other robots']]);

export const REGIONS = [['us', 'United States'], ['china', 'China'], ['europe', 'Europe'], ['asia', 'Japan and Korea']];
const REGION_LABEL = Object.fromEntries(REGIONS);

// The company a headline is about; the first named wins. Platform makers
// (Nvidia, Google) count when they're the subject.
export const COMPANIES = [
  ['tesla', 'Tesla', 'us', /\bTesla\b|\bOptimus\b/],
  ['figure', 'Figure', 'us', /\bFigure AI\b|\bFigure 0?\d\b|\bFigure['’]s (?:\S+ )?(?:humanoid|robot)s?\b/],
  ['agility', 'Agility Robotics', 'us', /\bAgility\b|\bDigit \d\b/],
  ['apptronik', 'Apptronik', 'us', /\bApptronik\b/],
  ['bostondynamics', 'Boston Dynamics', 'us', /\bBoston Dynamics\b/],
  ['onex', '1X', 'us', /\b1X\b|\bNEO (?:Gamma|humanoid|robot)\b/],
  ['pi', 'Physical Intelligence', 'us', /\bPhysical Intelligence\b/],
  ['skild', 'Skild AI', 'us', /\bSkild\b/],
  ['fieldai', 'FieldAI', 'us', /\bField ?AI\b/],
  ['sunday', 'Sunday Robotics', 'us', /\bSunday Robotics\b/],
  ['eka', 'Eka Robotics', 'us', /\bEka Robotics\b/],
  ['dyna', 'Dyna Robotics', 'us', /\bDyna Robotics\b/],
  ['generalist', 'Generalist AI', 'us', /\bGeneralist(?: AI)?\b/],
  ['faraday', 'Faraday Future', 'us', /\bFaraday Future\b|\bFF EAI\b|\bFFAI\b|\bFF Nova\b/],
  ['serve', 'Serve Robotics', 'us', /\bServe Robotics\b/],
  ['dreamlabs', 'Dream Labs', 'us', /\bDream Labs\b/],
  ['atoms', 'Atoms', 'us', /\bAtoms\b/],
  ['nvidia', 'Nvidia', 'us', /\bNvidia\b|\bNVIDIA\b|\bGR00T\b|\bJetson\b|\bIsaac Lab\b/],
  ['google', 'Google DeepMind', 'us', /\bGoogle\b|\bDeepMind\b|\bGemini Robotics\b/],
  ['amazon', 'Amazon', 'us', /\bAmazon\b/],
  ['openai', 'OpenAI', 'us', /\bOpenAI\b/],
  ['meta', 'Meta', 'us', /\bMeta\b/],
  ['apple', 'Apple', 'us', /\bApple\b/],
  ['unitree', 'Unitree', 'china', /\bUnitree\b/],
  ['ubtech', 'UBTech', 'china', /\bUBTech\b|\bUBTECH\b|\bWalker S\w*\b/i],
  ['xpeng', 'XPeng', 'china', /\bXPeng\b/i],
  ['agibot', 'AgiBot', 'china', /\bAgiBot\b|\bZhiyuan\b/i],
  ['fourier', 'Fourier', 'china', /\bFourier\b/],
  ['galbot', 'Galbot', 'china', /\bGalbot\b/i],
  ['noetix', 'Noetix', 'china', /\bNoetix\b/i],
  ['engineai', 'EngineAI', 'china', /\bEngineAI\b/i],
  ['xiaomi', 'Xiaomi', 'china', /\bXiaomi\b/],
  ['deepseek', 'DeepSeek', 'china', /\bDeepSeek\b/],
  ['roborock', 'Roborock', 'china', /\bRoborock\b/],
  ['ecovacs', 'Ecovacs', 'china', /\bEcovacs\b/i],
  ['pudu', 'Pudu', 'china', /\bPudu\b/],
  ['huawei', 'Huawei', 'china', /\bHuawei\b/],
  ['alibaba', 'Alibaba', 'china', /\bAlibaba\b/],
  ['byd', 'BYD', 'china', /\bBYD\b/],
  ['neura', 'Neura Robotics', 'europe', /\bNEURA\b|\bNeura Robotics\b/],
  ['humanoidco', 'Humanoid (UK)', 'europe', /\bHumanoid(?=\s+(?:[Rr]aises|[Tt]aps|[Aa]nd\s+[A-Z]|[Ss]igns|[Uu]nveils|[Ll]aunches|[Bb]ring|[Pp]artners|[Ss]ecures)\b|,\s+[A-Z])/],
  ['agilerobots', 'Agile Robots', 'europe', /\bAgile Robots\b/],
  ['mimic', 'mimic', 'europe', /\bmimic robotics\b|\bFLUX-mimic\b/i],
  ['ur', 'Universal Robots', 'europe', /\bUniversal Robots\b/],
  ['abb', 'ABB', 'europe', /\bABB\b/],
  ['wandercraft', 'Wandercraft', 'europe', /\bWandercraft\b/],
  ['pollen', 'Pollen Robotics', 'europe', /\bPollen Robotics\b/],
  ['enact', 'Enact', 'europe', /\bEnact\b/],
  ['bionics', 'Generative Bionics', 'europe', /\bGenerative Bionics\b/],
  ['siemens', 'Siemens', 'europe', /\bSiemens\b/],
  ['starship', 'Starship', 'europe', /\bStarship (?:robots?|Technologies)\b/],
  ['hyundai', 'Hyundai', 'asia', /\bHyundai\b/],
  ['samsung', 'Samsung', 'asia', /\bSamsung\b|\bRainbow Robotics\b/],
  ['lg', 'LG', 'asia', /\bLG\b/],
  ['sony', 'Sony', 'asia', /\bSony\b/],
  ['toyota', 'Toyota', 'asia', /\bToyota\b/],
  ['softbank', 'SoftBank', 'asia', /\bSoftBank\b/],
  ['honda', 'Honda', 'asia', /\bHonda\b/],
  ['kawasaki', 'Kawasaki', 'asia', /\bKawasaki\b/],
];

const MONEY = /([$€£])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mn|tn|[bmkt])?(?![\p{L}\p{N}])/giu;
// A price tag: "$2,490 humanoid", "priced at $5,900", "$399 Microduck".
const PRICE = /\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d\d)?(?!\s*(?:trillion|billion|million|thousand|bn|mn|tn|[bmkt])\b)(?![\d,.])/i;
const PRICE_CONTEXT = /\bpric\w*|\bcosts?\b|\bpre-?orders?\b|\bon sale\b|\bfor \$|\$[\d,]+\s+(?:\S+ ){0,2}(?:humanoid|robot|Nova|Microduck|Mini)\b|\bunder \$|\bbelow \$|\bcheap\w*|\bafford\w*/i;
const TALKS = /\bin talks\b|\bseeks?\b|\bseeking\b|\beyes\b|\bset to\b|\breportedly\b|\bplans? to\b|\bnears?\b|\bcould\b|\bweighs\b|\bconsider\w*/i;
const VALUATION = /(?:\bvaluation(?: of)?|\bvalued at|\bat (?:a |an )?|\bworth|\btops?|\bhits?|\bover|\bto)\s*$/i;
const BACKER = /\b(?:pulled|backed by|led by|from|investors?|backers?)\b[^.]{0,40}$/i;
const FORMER = /(?:\bex-|\bformer\s+|\bex\s+)$/i;
const UNITS = /\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(million|thousand|k)?\s+(?:units|humanoids|humanoid robots|robots)\b/i;

export function parseRobot(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (!ROBOT.test(title) || NOT_ROBOT.test(title)) return null;
  const kind = KINDS.find(([, , re]) => re.test(title))?.[0];
  if (!kind) return null;
  const form = FORMS.find(([, , re]) => re.test(title))?.[0] || 'other';
  let company = null;
  let first = Infinity;
  for (const [key, label, region, re] of COMPANIES) {
    const m = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
    for (const x of title.matchAll(m)) {
      // "Ex-DeepMind founders' startup" is about the startup.
      if (FORMER.test(title.slice(0, x.index)) || (kind === 'funding' && BACKER.test(title.slice(0, x.index)))) continue;
      if (x.index < first) { first = x.index; company = { key, label, region }; }
      break;
    }
  }
  // A startup that isn't on the list, named before its verb ("Origin raises").
  if (!company && kind === 'funding') {
    const v = /\b(?:raises|raised|secures|lands|grabs|closes|bags|nabs)\b/i.exec(title);
    const name = v && nameBefore(title.slice(0, v.index));
    if (name && name.length <= 30 && !/^(?:Robotics?|Humanoid|Startup|AI|Physical AI)$/i.test(name)) company = { key: companyKey(name), label: name, region: null };
  }
  let usd = null;
  // The round, not the valuation, and only once it's done.
  if (kind === 'funding' && !TALKS.test(title)) {
    for (const m of title.matchAll(MONEY)) {
      const v = parseMoney(m[1], m[2], m[3]);
      if (VALUATION.test(title.slice(Math.max(0, m.index - 30), m.index)) || /^\s*(?:post-money |pre-money )?valuation/i.test(title.slice(m.index + m[0].length))) continue;
      if (v && v >= 1e5 && (!usd || v > usd)) usd = v;
    }
  }
  let price = null;
  const pm = PRICE.exec(title);
  if (pm && PRICE_CONTEXT.test(title) && kind !== 'funding') {
    const v = Number(pm[1].replace(/,/g, ''));
    if (v >= 100 && v <= 500000) price = v;
  }
  let units = null;
  let year = null;
  const um = UNITS.exec(title);
  if (um && (kind === 'production' || kind === 'deploy')) {
    const v = Number(um[1].replace(/,/g, '')) * ({ million: 1e6, thousand: 1e3, k: 1e3 }[um[2]?.toLowerCase()] || 1);
    if (v >= 10 && !(/^20[2-4]\d$/.test(um[1]) && !um[2])) {
      units = v;
      year = Number(title.match(/\b(20[2-4]\d)\b/)?.[1]) || null;
    }
  }
  return { title, kind, form, company, usd, price, units, year };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeRobots(db, now = Date.now(), days = ROBOT_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);
  const events = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue; // English headlines
    const p = parseRobot(r.title);
    if (!p) continue;
    headlines++;
    const source = outlet || r.source || r.site;
    const toks = new Set(tokens(title));
    // The same company and kind of news within a week, or without a company
    // the same story told the same way within three days.
    // A company's funding news within three weeks is one round.
    const same = events.find((x) => x.kind === p.kind && r.at - x.last < (p.company ? (p.kind === 'funding' ? 21 : 7) : 3) * DAY
      && (p.company ? x.company?.key === p.company.key && (p.kind === 'funding' || overlap(toks, x.toks) >= 0.25) : !x.company && overlap(toks, x.toks) >= 0.5));
    if (same) {
      same.last = r.at;
      same.outlets.add(source);
      for (const t of toks) same.toks.add(t);
      for (const k of ['usd', 'price', 'units', 'year']) same[k] ??= p[k];
      if (same.form === 'other') same.form = p.form;
      if (!same.reports.some((x) => overlap(toks, x.toks) >= 0.7)) same.reports.push({ at: r.at, title, url: r.url, source, toks });
      continue;
    }
    events.push({ ...p, at: r.at, last: r.at, url: r.url, source, outlets: new Set([source]), toks, reports: [{ at: r.at, title, url: r.url, source, toks }] });
  }

  // A named company, or a story more than one outlet carried.
  const out = events.filter((x) => x.company || x.outlets.size >= 2).map((x) => ({
    id: `${x.kind}-${x.company?.key || 'robots'}-${new Date(x.at).toISOString().slice(0, 10)}`,
    at: x.at,
    last: x.last,
    kind: x.kind,
    form: x.form,
    company: x.company,
    usd: x.usd,
    price: x.price,
    units: x.units,
    year: x.year,
    title: x.title,
    url: x.url,
    source: x.source,
    outlets: x.outlets.size,
    reports: x.reports.slice(0, 8).map(({ toks, ...r }) => r),
  })).sort((a, b) => b.at - a.at);

  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), n: 0, usd: 0, kinds: Object.fromEntries(KINDS.map(([k]) => [k, 0])), regions: Object.fromEntries(REGIONS.map(([k]) => [k, 0])) });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const x of out) {
    const m = months[mi.get(new Date(x.at).toISOString().slice(0, 7))];
    if (!m) continue;
    m.n++;
    m.kinds[x.kind]++;
    if (x.company?.region) m.regions[x.company.region]++;
    if (x.usd) m.usd += x.usd;
  }

  const in90 = (x) => x.at >= now - 90 * DAY;
  const prev90 = (x) => x.at < now - 90 * DAY && x.at >= now - 180 * DAY;
  const companies = new Map();
  for (const x of out) {
    if (!x.company) continue;
    const c = companies.get(x.company.key) || { ...x.company, n: 0, n90: 0, usd: 0, kinds: {}, last: 0 };
    c.n++;
    if (in90(x)) c.n90++;
    if (x.usd) c.usd += x.usd;
    c.kinds[x.kind] = (c.kinds[x.kind] || 0) + 1;
    c.last = Math.max(c.last, x.at);
    companies.set(c.key, c);
  }

  const named90 = out.filter((x) => x.company?.region && in90(x));
  const share = (region) => (named90.length ? named90.filter((x) => x.company.region === region).length / named90.length : 0);
  const rounds = out.filter((x) => x.usd).sort((a, b) => b.usd - a.usd);
  // One price per company and product: the first time it was reported.
  const prices = [];
  for (const x of [...out].reverse()) {
    if (!x.price || prices.some((p) => p.company?.key === x.company?.key && Math.abs(p.price - x.price) <= p.price * 0.05)) continue;
    prices.push({ id: x.id, at: x.at, price: x.price, company: x.company, form: x.form, title: x.title, url: x.url });
  }
  const targets = out.filter((x) => x.units).map((x) => ({ id: x.id, at: x.at, units: x.units, year: x.year, company: x.company, kind: x.kind, title: x.title, url: x.url }));

  return {
    generatedAt: now,
    days,
    headlines,
    events: out.slice(0, 500),
    months,
    kinds: KINDS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.kind === key).length, n90: out.filter((x) => x.kind === key && in90(x)).length })),
    forms: [...FORMS.map(([k]) => k), 'other'].map((key) => ({ key, label: FORM_LABEL[key], n: out.filter((x) => x.form === key).length })),
    regions: REGIONS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.company?.region === key).length, n90: named90.filter((x) => x.company.region === key).length, prev90: out.filter((x) => x.company?.region === key && prev90(x)).length })),
    companies: [...companies.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 24),
    rounds: rounds.slice(0, 15).map(({ reports, ...x }) => x),
    prices: prices.sort((a, b) => a.price - b.price),
    targets: targets.slice(0, 20),
    labels: { kinds: KIND_LABEL, forms: FORM_LABEL, regions: REGION_LABEL },
    stats: {
      events: out.length,
      n90: out.filter(in90).length,
      prev90: out.filter(prev90).length,
      raised: rounds.reduce((n, x) => n + x.usd, 0),
      raised90: rounds.filter(in90).reduce((n, x) => n + x.usd, 0),
      rounds: rounds.length,
      usShare90: share('us'),
      chinaShare90: share('china'),
      biggest: rounds[0] ? { title: rounds[0].title, url: rounds[0].url, usd: rounds[0].usd, company: rounds[0].company } : null,
    },
  };
}

export const robotsQuery = () => cachedJob('robots', { kind: 'robots' }, TTL_MS);
