// The buildout: AI data centers from a year of headlines. A project headline
// names who is building ("Meta", "Stargate"), often where (a US state, a city
// we can place, a country), how big (gigawatts, megawatts), how much ("$10
// billion") and what powers it (gas, nuclear, solar). A pushback headline is
// a town or state saying no: a moratorium or pause, a ban, a rejected permit,
// a withdrawn plan, a lawsuit, a protest. Headlines about the same builder in
// the same place are one project; places collect both.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { nameBefore } from './deals.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const BUILDOUT_DAYS = 365;

const FTS = 'title:("data center" OR "data centers" OR "data centre" OR "data centres" OR datacenter* OR datacentre* OR "AI factory" OR "AI factories" OR stargate OR hyperscale* OR gigawatt* OR "AI campus" OR "AI supercomputer" OR colossus OR hyperion)';
const ABOUT = /\bdata ?cent(?:er|re)s?\b|\bAI (?:factor(?:y|ies)|campus(?:es)?|supercomputers?|hubs?|infrastructure)\b|\bstargate\b|\bhyperscale|\bgigawatt|\bcolossus\b|\bhyperion\b/i;
// Market-research releases, stock tips, how-tos and the other senses.
const NOT_ABOUT = /\bmarket (?:to reach|size|share|report|forecast|worth|is expected|projected|growth|outlook)\b|\bCAGR\b|\bstocks? to (?:buy|watch)\b|\b(?:buy|sell)(?:ing)? (?:these|this|the) \w+ stocks?\b|\bshares? (?:in|of) this\b|\bditch the data cent|\bbeyond the data cent|\bwebinar\b|\bpodcast\b|\bhow to\b|\bjob(?:s)? (?:at|in)\b|\bhiring\b|\bstrike[sd]?\b.*\b(?:drone|missile)|\bdrones?\b|\bin space\b|\borbit|\bsmuggl\w*|\bseiz\w+|\barrest\w*(?! while protest)|\bcharged with\b/i;

export const PUSHBACK = [
  ['moratorium', 'Moratorium or pause', /\bmoratori\w*|\bpaus(?:e|es|ed|ing)\b|\bhalt(?:s|ed|ing)?\b|\bfreez(?:e|es)\b|\bput(?:s|ting)? (?:the )?brakes\b/i],
  ['ban', 'Ban or block', /\bbans?\b|\bbanned\b|\bbanning\b|\bblock(?:s|ed|ing)?\b|\bprohibit\w*|\bkeep out\b|\bpushed (?:data centers )?off\b|\bpull(?:s|ed)? the plug\b/i],
  ['rejected', 'Rejected', /\breject(?:s|ed|ing)?\b|\bden(?:y|ies|ied)\b|\bvot(?:e|es|ed) (?:down|against|no)\b|\bturn(?:s|ed)? down\b|\bvetoe?s?d?\b|\bsays? no\b/i],
  ['withdrawn', 'Withdrawn or cancelled', /\bwithdr[ae]w\w*|\bscrap(?:s|ped|ping)?\b|\babandon\w*|\bcancel\w*|\bpull(?:s|ed|ing)? out\b|\bdrop(?:s|ped)? (?:its |their |the )?plans?\b|\bshelv\w+|\bwalks? away\b|\bbacks? out\b/i],
  ['lawsuit', 'Lawsuit', /\blawsuits?\b|\bsu(?:e|es|ed|ing)\b|\bclass[- ]action\b|\bin court\b|\bjudge\b/i],
  ['protest', 'Protest and opposition', /\bprotest\w*|\boppos\w+|\bbacklash\b|\brevolt\w*|\bpushback\b|\bpush back\b|\bfight(?:s|ing)?\b|\boutrage\b|\banger\b|\bangry\b|\bresist\w*|\bcontroversial\b|\bslam(?:s|med)?\b|\bpetition\b|\bpolitically toxic\b|\bskeptical communities\b/i],
];
const PUSH_KIND = Object.fromEntries(PUSHBACK.map(([k, l]) => [k, l]));

const PROJECT = /\bannounc\w*|\bunveil\w*|\bplans?\b|\bplanned\b|\bbuild(?:s|ing)?\b|\bbreaks? ground\b|\bground ?breaking\b|\bconstruct\w*|\binvest\w*|\bopens?\b|\bopening\b|\blaunch\w*|\bexpand\w*|\bexpansion\b|\bcampus\b|\bselects?\b|\bpicks?\b|\bapprov\w*|\bgreen[- ]?light\w*|\bgoes live\b|\bcomes? online\b|\bonline\b|\bsite\b|\bproposed?\b|\bdevelop\w*|\bdeal\b|\bpartner\w*|\bfinanc\w*|\bfunding\b|\braises?\b|\bbillion\b/i;
const STATUS = [
  ['online', /\bopens?\b|\bopened\b|\bgoes live\b|\bwent live\b|\bcomes? online\b|\bcame online\b|\boperational\b|\bswitch(?:es|ed)? on\b|\bnow live\b/i],
  ['construction', /\bbreaks? ground\b|\bbroke ground\b|\bground ?breaking\b|\bunder construction\b|\bbegins? construction\b|\bstarts? construction\b|\bconstruction (?:begins|starts|underway)\b/i],
  ['approved', /\bapprov(?:e|es|ed|al)\b|\bgreen[- ]?light\w*|\bclears?\b|\bpermit(?:s|ted)? (?:granted|issued)\b|\brezon\w*/i],
];
export const STATUS_RANK = { announced: 0, approved: 1, construction: 2, online: 3, cancelled: 4 };

export const POWER = [
  ['nuclear', 'Nuclear', /\bnuclear\b|\bSMRs?\b|\breactors?\b|\bfission\b|\bthree mile island\b/i],
  ['gas', 'Natural gas', /\b(?:natural )?gas\b|\bturbines?\b|\bLNG\b|\bgas-fired\b/i],
  ['solar', 'Solar', /\bsolar\b/i],
  ['wind', 'Wind', /\bwind (?:farm|power|energy)\b|\boffshore wind\b/i],
  ['geothermal', 'Geothermal', /\bgeothermal\b/i],
  ['hydro', 'Hydro', /\bhydro(?:electric|power)?\b|\bdams?\b/i],
  ['fusion', 'Fusion', /\bfusion (?:power|energy|reactors?|plants?|startup)\b|\bhelion\b|\bcommonwealth fusion\b/i],
  ['coal', 'Coal', /\bcoal\b/i],
  ['batteries', 'Batteries', /\bbatter(?:y|ies)\b|\benergy storage\b/i],
];
const POWER_LABEL = Object.fromEntries(POWER.map(([k, l]) => [k, l]));
const GRID = /\bgrid\b|\belectric(?:ity)? (?:bills?|prices?|rates?|costs?|demands?)\b|\butilit(?:y|ies)\b|\bpower (?:demand|bills?|prices?|plants?|deals?|purchase|supply)\b|\bratepayers?\b|\bwater\b/i;

// US states with their tile-grid position (column, row) for the map.
export const STATES = [
  ['AK', 'Alaska', 0, 0], ['ME', 'Maine', 11, 0],
  ['VT', 'Vermont', 10, 1], ['NH', 'New Hampshire', 11, 1],
  ['WA', 'Washington', 1, 2], ['ID', 'Idaho', 2, 2], ['MT', 'Montana', 3, 2], ['ND', 'North Dakota', 4, 2], ['MN', 'Minnesota', 5, 2], ['IL', 'Illinois', 6, 2], ['WI', 'Wisconsin', 7, 2], ['MI', 'Michigan', 8, 2], ['NY', 'New York', 9, 2], ['RI', 'Rhode Island', 10, 2], ['MA', 'Massachusetts', 11, 2],
  ['OR', 'Oregon', 1, 3], ['NV', 'Nevada', 2, 3], ['WY', 'Wyoming', 3, 3], ['SD', 'South Dakota', 4, 3], ['IA', 'Iowa', 5, 3], ['IN', 'Indiana', 6, 3], ['OH', 'Ohio', 7, 3], ['PA', 'Pennsylvania', 8, 3], ['NJ', 'New Jersey', 9, 3], ['CT', 'Connecticut', 10, 3],
  ['CA', 'California', 1, 4], ['UT', 'Utah', 2, 4], ['CO', 'Colorado', 3, 4], ['NE', 'Nebraska', 4, 4], ['MO', 'Missouri', 5, 4], ['KY', 'Kentucky', 6, 4], ['WV', 'West Virginia', 7, 4], ['VA', 'Virginia', 8, 4], ['MD', 'Maryland', 9, 4], ['DE', 'Delaware', 10, 4],
  ['AZ', 'Arizona', 2, 5], ['NM', 'New Mexico', 3, 5], ['KS', 'Kansas', 4, 5], ['AR', 'Arkansas', 5, 5], ['TN', 'Tennessee', 6, 5], ['NC', 'North Carolina', 7, 5], ['SC', 'South Carolina', 8, 5], ['DC', 'District of Columbia', 9, 5],
  ['OK', 'Oklahoma', 4, 6], ['LA', 'Louisiana', 5, 6], ['MS', 'Mississippi', 6, 6], ['AL', 'Alabama', 7, 6], ['GA', 'Georgia', 8, 6],
  ['HI', 'Hawaii', 0, 7], ['TX', 'Texas', 4, 7], ['FL', 'Florida', 9, 7],
];
// Places named without their state, and the state they're in. Plain
// "Washington" is usually the capital, so the state needs "state" after it.
const CITIES = {
  abilene: 'TX', amarillo: 'TX', shackelford: 'TX', 'milam county': 'TX', dallas: 'TX', houston: 'TX', austin: 'TX', 'san antonio': 'TX', 'el paso': 'TX', 'fort worth': 'TX', ercot: 'TX', tceq: 'TX',
  memphis: 'TN', nashville: 'TN', ashburn: 'VA', loudoun: 'VA', 'prince william': 'VA', 'northern virginia': 'VA', 'new albany': 'OH', columbus: 'OH', cleveland: 'OH', cincinnati: 'OH', lordstown: 'OH',
  'mount pleasant': 'WI', 'port washington': 'WI', milwaukee: 'WI', madison: 'WI', 'richland parish': 'LA', 'new orleans': 'LA', cheyenne: 'WY', lancaster: 'PA', pittsburgh: 'PA', philadelphia: 'PA', 'three mile island': 'PA',
  saline: 'MI', detroit: 'MI', denver: 'CO', pittsburg: 'CA', gilroy: 'CA', 'east bay': 'CA', 'santa clara': 'CA', 'silicon valley': 'CA', 'los angeles': 'CA', 'san jose': 'CA', tucson: 'AZ', phoenix: 'AZ', mesa: 'AZ', atlanta: 'GA', chicago: 'IL', reno: 'NV', 'las vegas': 'NV',
  'salt lake': 'UT', 'utah county': 'UT', 'doña ana': 'NM', 'dona ana': 'NM', albuquerque: 'NM', 'des moines': 'IA', omaha: 'NE', indianapolis: 'IN', 'new carlisle': 'IN', charlotte: 'NC', quincy: 'WA', wenatchee: 'WA', 'washington state': 'WA', 'hillsboro': 'OR', boston: 'MA', 'new york city': 'NY', 'kansas city': 'MO', 'montgomery county': 'MD', 'oklahoma city': 'OK', tulsa: 'OK', 'baton rouge': 'LA', hayward: 'CA', marana: 'AZ', muskogee: 'OK', hyperion: 'LA', 'prometheus': 'OH', colossus: 'TN', fairwater: 'WI', 'project camellia': 'GA', 'san marcos': 'TX', 'bastrop': 'TX', 'frederick': 'MD', 'culpeper': 'VA', 'fayette county': 'GA', 'tucker county': 'WV', 'cumberland county': 'NC', 'box elder': 'UT', 'eagle mountain': 'UT', 'cedar rapids': 'IA', 'council bluffs': 'IA', 'papillion': 'NE',
};
export const COUNTRIES = [
  ['canada', 'Canada', /\bcanad\w*|\bottawa\b|\balberta\b|\bquebec\b|\bontario\b|\bsaskatchewan\b|\bbritish columbia\b/i],
  ['uk', 'United Kingdom', /\bUK\b|\bU\.K\.|\bbritain\b|\bbritish\b(?! columbia)|\bengland\b|\bscotland\b|\bwales\b|\blondon\b/i],
  ['ireland', 'Ireland', /\bireland\b|\birish\b|\bdublin\b/i],
  ['france', 'France', /\bfrance\b|\bfrench\b|\bparis\b/i],
  ['germany', 'Germany', /\bgermany\b|\bgerman\b|\bberlin\b|\bfrankfurt\b/i],
  ['netherlands', 'Netherlands', /\bnetherlands\b|\bdutch\b|\bamsterdam\b/i],
  ['nordics', 'Nordics', /\bnorw\w+|\bsweden\b|\bswedish\b|\bfinland\b|\bfinnish\b|\bdenmark\b|\bdanish\b|\biceland\w*|\bnordic\b/i],
  ['spain', 'Spain and Portugal', /\bspain\b|\bspanish\b|\bportugal\b|\bportuguese\b|\baragon\b/i],
  ['italy', 'Italy', /\bital(?:y|ian)\b/i],
  ['india', 'India', /\bindia\b|\bindian\b|\bmumbai\b|\bchennai\b|\bhyderabad\b|\bvisakhapatnam\b|\bbengaluru\b|\bdelhi\b/i],
  ['japan', 'Japan', /\bjapan\w*|\btokyo\b|\bhokkaido\b/i],
  ['korea', 'South Korea', /\bkorea\w*|\bseoul\b|\bansan\b/i],
  ['china', 'China', /\bchin(?:a|ese)\b|\bbeijing\b|\bshanghai\b/i],
  ['taiwan', 'Taiwan', /\btaiwan\w*/i],
  ['seasia', 'Southeast Asia', /\bsingapore\b|\bmalaysia\w*|\bjohor\b|\bindonesia\w*|\bthai(?:land)?\b|\bvietnam\w*|\bphilippine\w*/i],
  ['australia', 'Australia and NZ', /\baustralia\w*|\bnew zealand\b|\bsydney\b|\bmelbourne\b/i],
  ['gulf', 'Gulf states', /\bUAE\b|\babu dhabi\b|\bdubai\b|\bemirat\w*|\bsaudi\b|\bqatar\w*|\bbahrain\b|\bkuwait\b|\boman\b/i],
  ['latam', 'Latin America', /\bbrazil\w*|\bmexic\w*|\bchile\w*|\bargentin\w*|\bcolombia\w*|\buruguay\w*/i],
  ['africa', 'Africa', /\bafrica\w*|\bkenya\w*|\bnigeria\w*|\bmorocc\w*|\begypt\w*/i],
  ['russia', 'Russia', /\brussia\w*|\bkaluga\b/i],
];

// Who's building: AI labs, clouds, chip makers and the data center companies.
export const BUILDERS = [
  ['openai', 'OpenAI', /\bopenai\b|\bstargate\b|\bsam altman\b/i],
  ['meta', 'Meta', /\bmeta\b|\bfacebook\b|\bhyperion\b|\bprometheus\b|\bzuckerberg\b/i],
  ['microsoft', 'Microsoft', /\bmicrosoft\b|\bfairwater\b|\bazure\b/i],
  ['google', 'Google', /\bgoogle\b|\balphabet\b/i],
  ['amazon', 'Amazon', /\bamazon\b|\bAWS\b/i],
  ['xai', 'xAI', /\bxai\b|\bcolossus\b|\bmusk\b/i],
  ['anthropic', 'Anthropic', /\banthropic\b/i],
  ['oracle', 'Oracle', /\boracle\b/i],
  ['nvidia', 'Nvidia', /\bnvidia\b|\bjensen huang\b/i],
  ['coreweave', 'CoreWeave', /\bcoreweave\b/i],
  ['crusoe', 'Crusoe', /\bcrusoe\b/i],
  ['nscale', 'Nscale', /\bnscale\b/i],
  ['nebius', 'Nebius', /\bnebius\b/i],
  ['softbank', 'SoftBank', /\bsoftbank\b/i],
  ['apple', 'Apple', /\bapple\b/i],
  ['sk', 'SK Group', /\bSK (?:group|hynix|telecom|broadband|hyper)\b/i],
  ['equinix', 'Equinix', /\bequinix\b/i],
  ['digital-realty', 'Digital Realty', /\bdigital realty\b/i],
  ['blackstone', 'Blackstone', /\bblackstone\b|\bQTS\b/i],
  ['brookfield', 'Brookfield', /\bbrookfield\b/i],
  ['vantage', 'Vantage', /\bvantage data\b/i],
  ['applied-digital', 'Applied Digital', /\bapplied digital\b/i],
  ['iren', 'IREN', /\bIREN\b/],
  ['core-scientific', 'Core Scientific', /\bcore scientific\b/i],
  ['fluidstack', 'Fluidstack', /\bfluidstack\b/i],
  ['lambda', 'Lambda', /\blambda\b/i],
  ['g42', 'G42', /\bG42\b|\bkhazna\b/i],
  ['humain', 'Humain', /\bhumain\b/i],
  ['reliance', 'Reliance', /\breliance\b|\bjio\b/i],
  ['tesla', 'Tesla', /\btesla\b|\bdojo\b/i],
  ['alibaba', 'Alibaba', /\balibaba\b/i],
  ['tencent', 'Tencent', /\btencent\b/i],
  ['bytedance', 'ByteDance', /\bbytedance\b|\btiktok\b/i],
  ['mistral', 'Mistral', /\bmistral\b/i],
  ['kevin-oleary', 'O’Leary Digital', /\bo['’]leary\b/i],
];

const STATE_BY_NAME = STATES.map(([code, name]) => [code, name, new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i')]).sort((a, b) => b[1].length - a[1].length);
const CITY_RE = new RegExp(`\\b(${Object.keys(CITIES).sort((a, b) => b.length - a.length).map((c) => c.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

export function placeOf(title) {
  for (const [code, name, re] of STATE_BY_NAME) {
    if (code === 'WA' || code === 'DC') continue;
    if (code === 'VA' && /\bwest virginia\b/i.test(title) && !/(?<!west )virginia\b/i.test(title.replace(/west virginia/gi, ''))) continue;
    if (code === 'GA' && /\b(?:georgia (?:tech|power)|tbilisi)\b/i.test(title) && !/georgia power/i.test(title)) continue;
    if (re.test(title)) return { key: code, label: name, us: true };
  }
  const c = CITY_RE.exec(title);
  if (c) {
    const code = CITIES[c[1].toLowerCase().replace(/\s+/g, ' ')];
    const st = STATES.find((s) => s[0] === code);
    return { key: code, label: st[1], us: true, city: c[1] };
  }
  for (const [key, label, re] of COUNTRIES) if (re.test(title)) return { key, label, us: false };
  return null;
}

// Capacity in gigawatts; one figure per headline (the largest).
const CAP = /(\d+(?:[.,]\d+)?)\s?-?\s?(gigawatts?|GW|megawatts?|MW)\b/gi;
export function capacityOf(title) {
  let best = null;
  for (const m of title.matchAll(CAP)) {
    const n = Number(m[1].replace(',', '.'));
    const gw = /^g/i.test(m[2]) ? n : n / 1000;
    if (gw > 0 && (best == null || gw > best)) best = gw;
  }
  if (best == null && /\b(?:a|one|first|multi-?)\s?gigawatt\b/i.test(title)) best = 1;
  return best != null && best <= 20 ? Math.round(best * 1000) / 1000 : null;
}

const MONEY = /(?:\$|US\$|USD\s?)\s?(\d+(?:\.\d+)?)\s?(trillion|billion|bn|b|million|mn|m)\b/i;
export function moneyOf(title) {
  const m = MONEY.exec(title);
  if (!m) return null;
  const v = +m[1] * (/^t/i.test(m[2]) ? 1e12 : /^b/i.test(m[2]) ? 1e9 : 1e6);
  return v <= 1.5e12 ? v : null;
}

// Fleet-wide goals and chip deals aren't a site's size: "13 gigawatts of
// compute by next year", "2 GW of GPUs".
const TARGET = /\bcompute\b|\bby (?:the )?(?:end of )?(?:next year|20\d\d)\b|\btarget\w*|\bgoal\b|\bambitions?\b|\bGPUs?\b|\bTPUs?\b|\bchips?\b|\bXPUs?\b|\bpipeline\b|\bnationwide\b|\bconnected\b|\brequests?\b/i;
const NOT_COST = /\b(?:in|of) (?:revenue|sales|valuation|market (?:cap|value))\b|\bvaluation\b|\bworth\b|\bbonds?\b|\btax (?:breaks?|credits?|revenue)\b|\bbills?\b|\binsurance\b/i;

// A builder outside the list, from the headline's subject: "KT Cloud Breaks
// Ground on ...", "Colt DCS, RMZ Start Construction ...".
const LEAD = /^(.{2,48}?)\s+(?:plans?|to (?:build|fuel|open|develop|invest)|breaks?|broke|starts?|announces?|unveils?|commits?|builds?|acquires?|launches?|opens?|partners?|targets?|secures?|raises?|picks?|selects?|will|eyes?|expands?|completes?|invests?)\b/i;
const NOT_BUILDER = /^(?:US|U\.S\.|New|The|AI|Data|Big|Tech|Report|Exclusive|Startup|Company|Firm|Residents?|City|County|State|Council|Officials?|Governor|Trump|Biden|Congress|Senate|EPA|FERC|Utilities?|Utility|Developer|Investors?)$/i;
function leadBuilder(title) {
  const m = LEAD.exec(title);
  if (!m) return null;
  const name = nameBefore(m[1].replace(/,.*$/, ''));
  if (!name || name.length > 32 || NOT_BUILDER.test(name) || NOT_BUILDER.test(name.split(' ')[0]) || placeOf(name)) return null;
  return { key: name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'), label: name, inferred: true };
}

export function parseBuildout(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (!ABOUT.test(title) || NOT_ABOUT.test(title)) return null;
  const push = PUSHBACK.filter(([, , re]) => re.test(title)).map(([k]) => k);
  const power = POWER.filter(([, , re]) => re.test(title)).map(([k]) => k);
  const known = BUILDERS.find(([, , re]) => re.test(title));
  const builder = known ? { key: known[0], label: known[1] } : leadBuilder(title);
  const gw = TARGET.test(title) ? null : capacityOf(title);
  const amount = NOT_COST.test(title) ? null : moneyOf(title);
  // A site's power bill or idle racks are grid news, not a project.
  const isProject = !(GRID.test(title) && !builder) && !!(gw || (builder && (amount || PROJECT.test(title))) || (amount && PROJECT.test(title)));
  // Pushback first: "Amazon withdraws plans after backlash" is about the backlash.
  const kind = push.length ? 'pushback' : isProject ? 'project' : power.length || GRID.test(title) ? 'power' : 'other';
  let status = 'announced';
  if (push.includes('withdrawn')) status = 'cancelled';
  else for (const [k, re] of STATUS) if (re.test(title)) { status = k; break; }
  return {
    title,
    kind,
    push,
    power,
    builder,
    place: placeOf(title),
    gw,
    amount,
    status,
  };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

function monthsBack(now, n) {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function computeBuildout(db, now = Date.now(), days = BUILDOUT_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);

  // Events: the same headline from several outlets within two days is one.
  const events = [];
  const recent = [];
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { outlet } = splitOutlet(r.title);
    const p = parseBuildout(r.title);
    if (!p || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(p.title)) continue;
    const toks = new Set(tokens(p.title));
    const source = outlet || r.source || r.site;
    while (recent.length && r.at - recent[0].last > 2 * DAY) recent.shift();
    const same = recent.find((e) => e.kind === p.kind && overlap(toks, e.toks) >= 0.6);
    if (same) {
      same.outlets.add(source);
      same.last = r.at;
      same.gw ??= p.gw;
      same.amount ??= p.amount;
      same.place ??= p.place;
      same.builder ??= p.builder;
      continue;
    }
    const e = { ...p, at: r.at, last: r.at, url: r.url, source, outlets: new Set([source]), toks };
    events.push(e);
    recent.push(e);
  }

  // Projects: one builder in one place (or, placeless, one builder at one size).
  const projects = new Map();
  for (const e of events) {
    if (e.kind !== 'project' && !(e.kind === 'pushback' && e.builder && e.place)) continue;
    // A project is somewhere: a builder's plans with no place are its fleet.
    if (!e.place || !(e.builder || e.gw || e.amount)) continue;
    const id = e.builder ? `${e.builder.key}--${e.place.key}` : `${e.place.key}--${e.gw || e.amount}`;
    let p = projects.get(id);
    if (!p) {
      p = { id, builder: e.builder, place: e.place, gw: null, amount: null, power: new Set(), status: 'announced', events: [], push: false };
      projects.set(id, p);
    }
    if (e.gw) p.gw = Math.max(p.gw || 0, e.gw);
    if (e.amount) p.amount = Math.max(p.amount || 0, e.amount);
    for (const k of e.power) p.power.add(k);
    if (!p.place && e.place) p.place = e.place;
    if (e.kind === 'pushback') p.push = true;
    // Status moves forward, except a cancellation, which ends it.
    if (e.status === 'cancelled' || STATUS_RANK[e.status] > STATUS_RANK[p.status]) p.status = e.status;
    p.events.push(e);
  }
  const projectList = [...projects.values()]
    .map((p) => {
      const outlets = new Set(p.events.flatMap((e) => [...e.outlets]));
      return {
        id: p.id,
        name: p.builder ? `${p.builder.label}${p.place ? ` · ${p.place.city ? `${p.place.city.replace(/\b\w/g, (c) => c.toUpperCase())}, ` : ''}${p.place.label}` : ''}` : `${p.place.label} project`,
        builder: p.builder,
        place: p.place ? { key: p.place.key, label: p.place.label, us: p.place.us } : null,
        gw: p.gw,
        amount: p.amount,
        power: [...p.power],
        status: p.status,
        pushback: p.push,
        first: p.events[0].at,
        last: p.events.at(-1).last,
        outlets: outlets.size,
        events: p.events.slice(-12).map((e) => ({ at: e.at, kind: e.kind, title: e.title, url: e.url, source: e.source, outlets: e.outlets.size })),
      };
    })
    // A single one-outlet headline without a size or sum isn't a project yet.
    .filter((p) => p.outlets >= 2 || p.gw || p.amount)
    .sort((a, b) => (b.gw || 0) - (a.gw || 0) || (b.amount || 0) - (a.amount || 0) || b.last - a.last);

  // Places: projects and pushback per US state and per country or region.
  const places = new Map();
  const placeOfKey = (pl) => {
    let x = places.get(pl.key);
    if (!x) {
      x = { key: pl.key, label: pl.label, us: pl.us, projects: 0, gw: 0, pushback: 0, push90: 0, kinds: {}, headlines: [] };
      places.set(pl.key, x);
    }
    return x;
  };
  for (const p of projectList) if (p.place) {
    const x = placeOfKey(p.place);
    x.projects++;
    x.gw += p.gw || 0;
  }
  const pushEvents = events.filter((e) => e.kind === 'pushback');
  for (const e of pushEvents) {
    if (!e.place) continue;
    const x = placeOfKey(e.place);
    x.pushback++;
    if (e.at >= now - 90 * DAY) x.push90++;
    for (const k of e.push) x.kinds[k] = (x.kinds[k] || 0) + 1;
  }
  for (const e of [...events].reverse()) {
    if (!e.place || e.kind === 'other') continue;
    const x = places.get(e.place.key);
    if (x && x.headlines.length < 4) x.headlines.push({ at: e.at, kind: e.kind, title: e.title, url: e.url, source: e.source });
  }
  for (const x of places.values()) x.gw = Math.round(x.gw * 100) / 100;

  // Twelve months of project, power and pushback news (each event once).
  const months = monthsBack(now, 12).map((m) => ({ m, project: 0, power: 0, pushback: 0 }));
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const e of events) {
    const m = months[mi.get(new Date(e.at).toISOString().slice(0, 7))];
    if (m && e.kind !== 'other') m[e.kind]++;
  }

  // Power sources named alongside data centers.
  const power = POWER.map(([key, label]) => {
    const evs = events.filter((e) => e.power.includes(key));
    return { key, label, n: evs.length, recent: evs.filter((e) => e.at >= now - 90 * DAY).length, latest: evs.at(-1) ? { title: evs.at(-1).title, url: evs.at(-1).url, at: evs.at(-1).at } : null };
  }).filter((p) => p.n).sort((a, b) => b.n - a.n);

  // Who's building: projects, gigawatts and money per builder.
  const builders = new Map();
  for (const p of projectList) if (p.builder) {
    const b = builders.get(p.builder.key) || { key: p.builder.key, label: p.builder.label, projects: 0, gw: 0, amount: 0, places: new Set() };
    b.projects++;
    b.gw += p.gw || 0;
    b.amount += p.amount || 0;
    if (p.place) b.places.add(p.place.label);
    builders.set(b.key, b);
  }

  const push90 = pushEvents.filter((e) => e.at >= now - 90 * DAY);
  const kinds = PUSHBACK.map(([key, label]) => ({ key, label, n: push90.filter((e) => e.push.includes(key)).length })).filter((k) => k.n);
  const share = (from, to) => {
    const evs = events.filter((e) => e.at >= from && e.at < to && e.kind !== 'other');
    return evs.length ? Math.round((100 * evs.filter((e) => e.kind === 'pushback').length) / evs.length) : null;
  };

  return {
    generatedAt: now,
    days,
    headlines: events.reduce((s, e) => s + e.outlets.size, 0),
    months,
    projects: projectList.slice(0, 160),
    places: [...places.values()].sort((a, b) => b.projects + b.pushback - (a.projects + a.pushback)),
    pushback: pushEvents.slice(-120).reverse().map((e) => ({ at: e.at, title: e.title, url: e.url, source: e.source, outlets: e.outlets.size, kinds: e.push, place: e.place ? { key: e.place.key, label: e.place.label } : null, builder: e.builder })),
    pushKinds: kinds,
    power,
    builders: [...builders.values()].map((b) => ({ ...b, gw: Math.round(b.gw * 100) / 100, places: [...b.places].slice(0, 6) })).sort((a, b) => b.gw - a.gw || b.projects - a.projects).slice(0, 14),
    stats: {
      projects: projectList.length,
      gw: Math.round(projectList.reduce((s, p) => s + (p.gw || 0), 0) * 10) / 10,
      amount: projectList.filter((p) => p.outlets >= 2).reduce((s, p) => s + (p.amount || 0), 0),
      pushback90: push90.length,
      placesSayingNo: new Set(push90.filter((e) => e.place && e.push.some((k) => ['moratorium', 'ban', 'rejected'].includes(k))).map((e) => e.place.key)).size,
      cancelled: projectList.filter((p) => p.status === 'cancelled').length,
      pushShare30: share(now - 30 * DAY, now + 1),
      pushSharePrev: share(now - 120 * DAY, now - 30 * DAY),
    },
    labels: { push: PUSH_KIND, power: POWER_LABEL },
  };
}

export const buildoutQuery = () => cachedJob('buildout', { kind: 'buildout' }, TTL_MS);
