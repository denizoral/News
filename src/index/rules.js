// AI rules: the bills, laws, executive orders and regulations being written
// about AI around the world, read from a year of headlines. A rules headline
// names a jurisdiction (Congress, the White House, a US state, the EU, the
// UK, China...), an instrument (a bill, an act, an order, rules) and how far
// it got: proposed, advancing, passed, signed, in force, or blocked (vetoed,
// struck down, delayed, repealed). Headlines about the same named measure
// ("SB 53", "the RAISE Act", "the AI Act"), or without a name the same
// jurisdiction and subject, are one measure; its furthest stage is where it
// stands, unless it was blocked since.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { STATES } from './buildout.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const RULES_DAYS = 365;

const FTS = 'title:(bill OR bills OR law OR laws OR act OR "executive order" OR regulat* OR legislat* OR veto* OR preempt* OR moratorium OR ban OR bans OR banned OR "export controls" OR "export control" OR rules OR lawmakers OR senate OR congress OR parliament OR governor OR signs OR signed OR enact* OR statute OR ordinance)';

const AI = /\bAI\b|\bA\.I\.|artificial intelligence|chatbots?|deepfakes?|frontier models?|\bLLMs?\b|algorithmic|\bAI-|\bgenerative\b|\bcompanion bots?\b|\bAI chips?\b|\bchip exports?\b|\bexport controls?\b/i;
const INSTRUMENT = /\bbills?\b|\b[A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,4}\s+Act\b|\bAI Act\b|\blaws?\b|\blegislat\w*|\bexecutive orders?\b|\bregulat\w*|\brules?\b(?! (?:out|of thumb))|\bban(?:s|ned|ning)?\b|\bmoratorium\b|\bpreempt\w*|\bexport controls?\b|\bstatute\b|\bordinance\b|\bguidelines\b|\bcode of practice\b|\bframework\b|\bveto\w*/i;
// Headlines that use the words but aren't about public rules.
const NOT_RULES = /\b(?:law firms?|lawyers?|legal (?:tech|ai|industry|research)|law school|law students|of the law|by law enforcement|law enforcement|laws of (?:physics|scaling)|scaling laws?|moore['’]s law|bill gates|billing|billable|rules of thumb|house rules|act(?:s|ing)? (?:like|as)|AI act(?:s|ing)? (?:like|as)|in the act|class act|balancing act|regulated (?:industries|sectors|environments?|firms?|enterprises?)|for regulated|compliance (?:platform|tool|software|startup)|lawsuit|sues?|sued|court|judge)\b|\btakeaways\b|\bguide\b|\bexplained\b|\bexplainer\b|\bFAQ\b|\bwhat (?:the|you|it|this|that)\b|\bhow (?:to|the|will|can|do|does)\b|\btips\b|\bwebinar\b|\bpodcast\b|\bcandidates?\b|\bcolleges?\b|\binstructors?\b|\bteachers?\b|\bfor HR\b|\bTech Today\b|\brumou?rs?\b|\?\s*$|\brewr(?:ite|ites|ote|iting|itten) (?:the )?rules\b|\brules of (?:the game|education|engagement|the road)\b|\bset(?:s|ting)? the rules\b|\bplay(?:s|ing)? by\b|\bbans? (?:AI|ai)-(?:made|generated|written)\b|\b(?:etsy|steam|reddit|wikipedia|spotify|youtube|school|university|college|magazine|journal|festival|contest|league|publisher)s? (?:bans?|banned)\b/i;

export const JURISDICTIONS = [
  ['eu', 'European Union', /\bEU\b|\bE\.U\.|\beuropean (?:union|commission|parliament|council)\b|\bbrussels\b|\bAI Act\b(?! of)|\beurope['’]s\b/i],
  ['uk', 'United Kingdom', /\bUK\b|\bU\.K\.|\bbritain\b|\bbritish\b|\bwestminster\b|\bofcom\b|\bengland\b|\bscotland\b/i],
  ['china', 'China', /\bchina\b|\bchinese\b|\bbeijing\b|\bCAC\b/i],
  ['japan', 'Japan', /\bjapan\w*/i],
  ['korea', 'South Korea', /\bkorea\w*|\bseoul\b/i],
  ['india', 'India', /\bindia\b|\bindian\b|\bMeitY\b|\bnew delhi\b/i],
  ['canada', 'Canada', /\bcanad\w*|\bottawa\b|\bontario\b|\bquebec\b/i],
  ['australia', 'Australia', /\baustralia\w*|\bcanberra\b/i],
  ['brazil', 'Brazil', /\bbrazil\w*/i],
  ['italy', 'Italy', /\bital(?:y|ian)\b/i],
  ['france', 'France', /\bfrance\b|\bfrench\b|\bparis\b/i],
  ['germany', 'Germany', /\bgermany\b|\bgerman\b/i],
  ['gulf', 'Gulf states', /\bUAE\b|\bemirat\w*|\bsaudi\b|\bqatar\w*/i],
  ['asia', 'Rest of Asia', /\bsingapore\b|\btaiwan\w*|\bvietnam\w*|\bindonesia\w*|\bmalaysia\w*|\bphilippine\w*|\bthailand\b/i],
  ['global', 'International', /\bUN\b|\bU\.N\.|\bunited nations\b|\bG7\b|\bG20\b|\bOECD\b|\btreaty\b|\bglobal (?:rules|regulation|governance|framework|pact|agreement)\b|\binternational (?:rules|agreement|treaty)\b|\bsummit\b/i],
];
const US_FEDERAL = /\bUS\b|\bU\.S\.|\bcongress\w*|\bsenat(?:e|ors?)\b|\bhouse (?:of representatives|lawmakers|passes|votes|republicans|democrats|bill|committee|panel|gop)\b|\bwhite house\b|\btrump\b|\bbiden\b|\bvance\b|\bfederal\b|\bFTC\b|\bFCC\b|\bFDA\b|\bSEC\b|\bcommerce department\b|\bdepartment of commerce\b|\bBIS\b|\bU\.?S\.? (?:lawmakers|government|bill|law|ban|rules|regulators|senate|house|officials|agencies|administration)\b|\bAmerican (?:lawmakers|AI action plan)\b|\bAI action plan\b|\bwashington\b(?! state)|\bsacks\b|\bcruz\b|\bhawley\b|\bblackburn\b|\bschumer\b|\bGOP\b|\brepublicans?\b|\bdemocrats?\b/i;
const STATE_RES = STATES.filter(([c]) => c !== 'DC' && c !== 'WA').map(([code, name]) => [code, name, new RegExp(`\\b${name.replace(/ /g, '\\s+')}(?:['’]s)?\\b`, 'i')]).sort((a, b) => b[1].length - a[1].length);
const STATE_WORDS = /\bstate (?:lawmakers|legislat\w+|laws?|bills?|level|regulators|rules|senate|assembly|AGs?|attorneys general)\b|\bstates\b|\bgovernors?\b|\bstatehouses?\b|\bnewsom\b|\bhochul\b|\bpolis\b|\babbott\b|\bdesantis\b|\bpritzker\b|\byoungkin\b|\bspanberger\b/i;
const GOVERNOR_STATE = { newsom: 'CA', hochul: 'NY', polis: 'CO', abbott: 'TX', desantis: 'FL', pritzker: 'IL', youngkin: 'VA', spanberger: 'VA' };

export function jurisdictionOf(title) {
  for (const [code, name, re] of STATE_RES) {
    if (code === 'VA' && /\bwest virginia\b/i.test(title) && !/(?<!west )virginia\b/i.test(title.replace(/west virginia/gi, ''))) continue;
    if (code === 'GA' && /\bgeorgia (?:tech|power)\b/i.test(title)) continue;
    if (code === 'NY' && /\bnew york times\b/i.test(title) && !/\bnew york(?! times)\b/i.test(title)) continue;
    if (re.test(title)) return { key: `us-${code.toLowerCase()}`, label: name, group: 'us-states' };
  }
  const gov = /\b(newsom|hochul|polis|abbott|desantis|pritzker|youngkin|spanberger)\b/i.exec(title);
  if (gov) {
    const code = GOVERNOR_STATE[gov[1].toLowerCase()];
    return { key: `us-${code.toLowerCase()}`, label: STATES.find((s) => s[0] === code)[1], group: 'us-states' };
  }
  // "US bans money for Chinese AI startups" is a US measure, about China.
  const eu = JURISDICTIONS[0][2].test(title) && !/\bU\.?S\.?\b(?! and)/.test(title);
  if (!eu && US_FEDERAL.test(title)) return { key: 'us-federal', label: 'US federal', group: 'us-federal' };
  for (const [key, label, re] of JURISDICTIONS) if (re.test(title)) return { key, label, group: key === 'global' ? 'global' : 'world' };
  // "25 states urge Congress" is the states.
  if (STATE_WORDS.test(title)) return { key: 'us-states', label: 'US states (several)', group: 'us-states' };
  return null;
}

export const STAGES = [
  ['blocked', 'Blocked, delayed or rolled back', /\bvetoe?s?d?\b|\bveto(?:es|ing)\b|\bblock(?:s|ed|ing)?\b|\bstrikes? down\b|\bstruck down\b|\binjunction\b|\bdelay(?:s|ed|ing)?\b|\bpostpone\w*|\bpaus(?:e|es|ed)\b|\brepeal\w*|\bscrap(?:s|ped)?\b|\brolls? back\b|\brollback\b|\bshelv\w+|\bwaters? down\b|\bwatered down\b|\bdies\b|\bfails?\b|\bfailed\b|\bstall(?:s|ed)?\b|\bwithdraw\w*/i],
  ['inforce', 'In force', /\btakes? effect\b|\btook effect\b|\b(?:goes|went|go) into effect\b|\bin force\b|\bcomes? into force\b|\benforcement (?:begins|starts)\b|\bnow (?:the )?law\b|\bkicks? in\b|\bnow in effect\b|\bbecomes? (?:effective|enforceable)\b/i],
  ['signed', 'Signed into law or ordered', /\bsigns?\b|\bsigned\b|\benact\w*|\binto law\b|\bexecutive orders?\b|\bissues? (?:new )?(?:rules|regulations|guidelines|order)\b|\bfinali[sz]e[sd]?\b|\bpublishe?s? (?:final )?rules\b|\bimposes?\b|\bimposed\b|\bunveils (?:new )?(?:export )?(?:rules|controls)\b/i],
  ['passed', 'Passed', /\bpass(?:es|ed)\b|\b(?:lawmakers|legislature|legislators|senate|house|assembly|parliament|congress|council|MPs) (?:\w+ )?(?:pass|approve|adopt)\b|\bapprov(?:es|ed)\b|\badopt(?:s|ed)\b|\bvotes? (?:to|for) (?:approve|pass|ban|adopt)\b|\bvoted (?:to|for)\b|\bgreen[- ]?light\w*/i],
  ['advancing', 'Advancing', /\badvanc\w*|\bclears?\b|\bcleared\b|\bmoves? forward\b|\bheads? to\b|\bcommittee (?:approves|backs|passes|votes)\b|\bmarkup\b|\bhearing\b|\bnears?\b|\bpush(?:es)? through\b|\bmoves? ahead\b/i],
  ['proposed', 'Proposed', /./],
];
export const STAGE_RANK = { proposed: 1, advancing: 2, passed: 3, signed: 4, inforce: 5, blocked: 0 };
const STAGE_LABEL = Object.fromEntries(STAGES.map(([k, l]) => [k, l]));

export const TOPICS = [
  ['chips', 'Chips and export controls', /\bexport\w*|\bchips?\b|\bsemiconductor\w*|\bnvidia\b|\bH20\b|\bH200\b|\bblackwell\b|\bentity list\b|\bGAIN AI\b/i],
  ['preemption', 'Federal preemption', /\bpreempt\w*|\bmoratorium on state\b|\bstate AI laws?\b.*\b(?:federal|ban|block|override|moratorium)\b|\b(?:federal|ban|block|override|moratorium)\b.*\bstate AI (?:laws?|regulations?|rules)\b|\bpatchwork\b|\bnational (?:AI )?standard\b|\bsingle federal\b|\bone rulebook\b/i],
  ['kids', 'Kids and companions', /\bchild\w*|\bkids?\b|\bminors?\b|\bteens?\b|\bage (?:verif\w*|checks?|limits?|gat\w*)\b|\bcompanion\w*|\bschools?\b|\bstudents?\b|\bparents?\b|\bsuicide\b|\bself-harm\b/i],
  ['deepfakes', 'Deepfakes and likeness', /\bdeepfakes?\b|\blikeness\b|\bnonconsensual\b|\bnon-consensual\b|\bvoice clon\w*|\bNO FAKES\b|\bTAKE IT DOWN\b|\bdigital replicas?\b|\belection\w*|\bnud(?:e|ify)\b|\bsexual\w*|\bwatermark\w*|\blabel(?:s|ing|led)? AI\b|\bAI[- ]generated (?:content|images|media)\b/i],
  ['safety', 'Frontier safety', /\bfrontier\b|\bsafety\b|\bcatastroph\w*|\bSB ?53\b|\bSB ?1047\b|\bRAISE Act\b|\bincidents?\b|\bdangerous\b|\bsuperintelligen\w*|\bextinction\b|\bAI labs?\b|\bmodel developers?\b|\btransparency\b|\bwhistleblow\w*/i],
  ['copyright', 'Copyright and training data', /\bcopyright\w*|\btraining data\b|\bcreators?\b|\bartists?\b|\bmusic\b|\bpublishers?\b|\bfair use\b|\blicens\w*/i],
  ['jobs', 'Jobs and discrimination', /\bjobs?\b|\bworkers?\b|\bemploy\w*|\bhiring\b|\bdiscriminat\w*|\bbias\b|\blabou?r\b|\blayoffs?\b|\bunions?\b|\bwages?\b/i],
  ['privacy', 'Privacy and surveillance', /\bprivacy\b|\bdata protection\b|\bGDPR\b|\bbiometric\w*|\bfacial recognition\b|\bsurveil\w*|\bpersonal data\b|\bpolic(?:e|ing)\b/i],
  ['health', 'Health and therapy', /\bhealth\w*|\bmedical\b|\btherap\w*|\bmental\b|\bdoctors?\b|\bpatients?\b|\binsur\w*|\bclinic\w*/i],
  ['energy', 'Data centers and energy', /\bdata ?cent(?:er|re)s?\b|\belectric\w*|\benergy\b|\bpower\b|\bgrid\b|\bwater\b|\butilit\w*/i],
  ['government', 'Government use and defense', /\bgovernment use\b|\bfederal agencies\b|\bagencies\b|\bprocurement\b|\bmilitary\b|\bpentagon\b|\bdefen[cs]e\b|\bweapons?\b|\bnational security\b/i],
  ['general', 'Broad AI rules', /./],
];
const TOPIC_LABEL = Object.fromEntries(TOPICS.map(([k, l]) => [k, l]));

// A measure's own name, when the headline gives one.
const BILL_NO = /\b(SB|AB|HB|SF|HF|LD|S|H\.?R)\.?\s?(\d{1,5})\b/;
const NAMED_ACT = /\b((?:[A-Z][A-Za-z.'’-]*|of|for|the|and|on|to|in)(?:\s+(?:[A-Z][A-Za-z.'’-]*|of|for|the|and|on|to|in)){0,7})\s+Act\b/;
// Words that start a sentence or say whose it is, not part of a name.
const ACT_STOP = new RegExp(`^(?:the|a|an|of|for|and|on|to|in|new|landmark|sweeping|proposed|draft|historic|bipartisan|federal|state|US|U\\.S\\.|EU|UK|what|why|how|under|after|before|with|amid|while|as|its|their|repeal|replace|says?|signs?|passes|passed|approves?|votes?|vetoes|vetoed|blocks?|delays?|amends?|first|latest|europe['’]s|china['’]s|${STATES.map((x) => x[1].replace(/ /g, '\\s')).join('|')})(?:['’]s?)?$`, 'i');
export function measureName(title) {
  const b = BILL_NO.exec(title);
  if (b && !/^\d{4}$/.test(b[2]) && !(b[1] === 'S' && !/\bS\.\s?\d/.test(title))) return `${b[1].replace(/\./g, '').toUpperCase()} ${b[2]}`;
  const a = NAMED_ACT.exec(title);
  if (a) {
    // The name is the run of words before "Act" back to a stop word.
    const all = a[1].split(/\s+/);
    const words = [];
    for (let i = all.length - 1; i >= 0; i--) {
      if (ACT_STOP.test(all[i]) && !/^(?:of|for|the|and|on|to|in)$/i.test(all[i])) break;
      words.unshift(all[i]);
    }
    while (words.length && /^(?:of|for|the|and|on|to|in)$/i.test(words[0])) words.shift();
    if (!words.length) return null;
    const name = `${words.join(' ')} Act`;
    if (/^(?:AI|Artificial Intelligence) Act$/i.test(name)) return 'AI Act';
    // A sentence in title case ("Signs Bill To Ban ... Act") isn't a name.
    if (words.length > 5 || /\b(?:Signs?|Passes|Bill|Law|Says?|Will|Would|New|Ban)\b/.test(words.join(' '))) return null;
    return name;
  }
  if (/\bexecutive order\b/i.test(title)) return 'Executive order';
  if (/\bAI action plan\b/i.test(title)) return 'AI Action Plan';
  if (/\bcode of practice\b/i.test(title)) return 'Code of practice';
  return null;
}

export function parseRules(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (!AI.test(title) || !INSTRUMENT.test(title) || NOT_RULES.test(title)) return null;
  const where = jurisdictionOf(title);
  if (!where) return null;
  const stage = STAGES.find(([, , re]) => re.test(title))[0];
  const topic = TOPICS.find(([, , re]) => re.test(title))[0];
  let name = measureName(title);
  // The AI Act is the EU's.
  const j = name === 'AI Act' && !/\b(?:colorado|texas|utah|illinois|california|new york|korea\w*|japan\w*|italy|italian)\b/i.test(title) ? { key: 'eu', label: 'European Union', group: 'world' } : where;
  if (name === 'Executive order' && j.key !== 'us-federal' && !j.key.startsWith('us-')) name = null;
  return { title, where: j, stage, topic, name };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeRules(db, now = Date.now(), days = RULES_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);

  const measures = new Map();
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { outlet } = splitOutlet(r.title);
    const p = parseRules(r.title);
    if (!p || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(p.title)) continue;
    headlines++;
    const id = p.name && p.name !== 'Executive order' ? `${p.where.key}--${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : p.name ? `${p.where.key}--eo-${p.topic}` : `${p.where.key}--${p.topic}`;
    let m = measures.get(id);
    if (!m) {
      m = { id, name: p.name, where: p.where, topics: new Map(), events: [] };
      measures.set(id, m);
    }
    m.topics.set(p.topic, (m.topics.get(p.topic) || 0) + 1);
    const toks = new Set(tokens(p.title));
    const source = outlet || r.source || r.site;
    const same = m.events.find((e) => e.stage === p.stage && r.at - e.last < 2 * DAY && overlap(toks, e.toks) >= 0.5);
    if (same) {
      same.outlets.add(source);
      same.last = r.at;
      continue;
    }
    m.events.push({ at: r.at, last: r.at, stage: p.stage, title: p.title, url: r.url, source, outlets: new Set([source]), toks });
  }

  const out = [];
  for (const m of measures.values()) {
    const outlets = new Set(m.events.flatMap((e) => [...e.outlets]));
    // One proposal headline from one outlet is talk, not a measure.
    if (m.events.length === 1 && outlets.size === 1 && m.events[0].stage === 'proposed') continue;
    const topic = [...m.topics].filter(([k]) => k !== 'general').sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';
    // Where it stands: the furthest stage reached, unless blocked after it.
    let best = 'proposed';
    for (const e of m.events) if (e.stage !== 'blocked' && STAGE_RANK[e.stage] > STAGE_RANK[best]) best = e.stage;
    const lastBlock = [...m.events].reverse().find((e) => e.stage === 'blocked');
    const lastFwd = [...m.events].reverse().find((e) => e.stage !== 'blocked' && e.stage !== 'proposed');
    const stage = lastBlock && (!lastFwd || lastBlock.at > lastFwd.at) ? 'blocked' : best;
    out.push({
      id: m.id,
      title: m.name ? (m.name === 'Executive order' ? `Executive order: ${TOPIC_LABEL[topic].replace(/^\w/, (c) => c.toLowerCase())}` : m.name) : `${TOPIC_LABEL[topic]}`,
      named: !!m.name,
      where: m.where,
      topic,
      stage,
      reached: best,
      first: m.events[0].at,
      last: m.events.at(-1).last,
      outlets: outlets.size,
      headlines: m.events.reduce((s, e) => s + e.outlets.size, 0),
      events: m.events.slice(-20).map((e) => ({ at: e.at, stage: e.stage, title: e.title, url: e.url, source: e.source, outlets: e.outlets.size })),
    });
  }
  out.sort((a, b) => b.last - a.last);

  // Twelve months of rules news by how far it got.
  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), proposed: 0, moving: 0, enacted: 0, blocked: 0 });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const x of out) for (const e of x.events) {
    const m = months[mi.get(new Date(e.at).toISOString().slice(0, 7))];
    if (!m) continue;
    if (e.stage === 'blocked') m.blocked++;
    else if (e.stage === 'signed' || e.stage === 'inforce') m.enacted++;
    else if (e.stage === 'passed' || e.stage === 'advancing') m.moving++;
    else m.proposed++;
  }

  // Jurisdictions: measures by where they stand.
  const juris = new Map();
  for (const x of out) {
    const j = juris.get(x.where.key) || { key: x.where.key, label: x.where.label, group: x.where.group, n: 0, stages: {}, topics: {}, last: 0 };
    j.n++;
    j.stages[x.stage] = (j.stages[x.stage] || 0) + 1;
    j.topics[x.topic] = (j.topics[x.topic] || 0) + 1;
    j.last = Math.max(j.last, x.last);
    juris.set(j.key, j);
  }
  const topics = TOPICS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.topic === key).length })).filter((t) => t.n);

  return {
    generatedAt: now,
    days,
    headlines,
    measures: out.slice(0, 300),
    months,
    jurisdictions: [...juris.values()].sort((a, b) => b.n - a.n),
    topics,
    stages: STAGES.map(([key, label]) => ({ key, label })),
    stats: {
      measures: out.length,
      named: out.filter((x) => x.named).length,
      enacted: out.filter((x) => x.stage === 'signed' || x.stage === 'inforce').length,
      blocked: out.filter((x) => x.stage === 'blocked').length,
      states: new Set(out.filter((x) => x.where.key.startsWith('us-') && x.where.key.length === 5).map((x) => x.where.key)).size,
      moved30: out.reduce((s, x) => s + x.events.filter((e) => e.at >= now - 30 * DAY && e.stage !== 'proposed').length, 0),
    },
  };
}

export const rulesQuery = () => cachedJob('rules', { kind: 'rules' }, TTL_MS);
