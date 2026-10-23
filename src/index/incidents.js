// AI incidents: the times AI went wrong, read from a year of headlines.
// An incident headline names a kind of failure (an agent that deleted a
// database, an AI-built exploit, a deepfake, a chatbot that made things up
// or harmed someone, a robotaxi crash), usually the product or company
// involved, sometimes what was done about it (paused, pulled, banned,
// patched, an apology, a probe, a lawsuit), and whether it happened in the
// world or in a lab. Headlines about the same product and kind of failure
// within days of each other are one incident.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const INCIDENT_DAYS = 365;

const FTS = 'title:(deepfake* OR hallucinat* OR jailbreak* OR "prompt injection" OR leak* OR leaked OR breach* OR vulnerab* OR flaw* OR scam* OR fraud* OR phishing OR misinformation OR disinformation OR rogue OR deleted OR deletes OR deleting OR wiped OR wipes OR exploit* OR hack* OR hacker* OR hackers OR glitch* OR apolog* OR suicide OR "self-harm" OR delusion* OR psychosis OR crash* OR crashes OR recall* OR fake OR fakes OR fabricat* OR impersonat* OR propaganda OR racist OR sabotag* OR blackmail* OR malware OR ransomware OR "went wrong" OR mistake* OR error* OR backfire* OR outage* OR "influence operation" OR "influence operations" OR nudify OR "made up" OR "fake cases" OR "fake citations") AND title:(AI OR chatbot* OR ChatGPT OR Claude OR Gemini OR Grok OR Copilot OR agent OR agents OR LLM OR Cursor OR Replit OR Waymo OR robotaxi* OR Autopilot OR FSD OR DeepSeek OR "Character.AI" OR Sora OR Llama)';

const AI = /\bAI\b|\bAI-\w+|artificial intelligence|chatbots?|ChatGPT|\bClaude\b|\bGemini\b|\bGrok\b|\bCopilot\b|\bagents?\b|\bagentic\b|\bLLMs?\b|\bCursor\b|\bReplit\b|\bWaymo\b|robotaxis?|\bAutopilot\b|\bFSD\b|\bDeepSeek\b|Character\.AI|\bSora\b|\bLlama\b|\bdeepfakes?\b/i;

// What went wrong, most specific first. A headline gets one kind.
export const KINDS = [
  ['agents', 'Agents gone wrong', /\brogue\b|\b(?:agent|agents|Claude|Cursor|Replit|Codex|Copilot|Gemini|ChatGPT|Grok|assistant|bot|AI|model)\b.{0,60}\b(?:delet(?:es|ed|ing)\b|wip(?:es|ed|ing)\b|destroy\w*|nuk\w*|drop(?:ped|s)? (?:the |a )?(?:database|table)|escap\w*|went off|deceiv\w*|sabotag\w*|blackmail\w*|jailbr\w*|bypass\w*|exploit\w* (?:a |the )?loophole)|\b(?:delet\w*|wip\w*|destroy\w*) (?:\S+ ){0,4}(?:database|files|codebase|repo|production|inbox|emails)\b.{0,60}\b(?:AI|agent|Claude|Cursor|Replit|Codex|Gemini)\b|\bAI (?:agent|model)s? (?:tried|tries|attempted) to\b|\breward hack\w*|\bscheming\b|\bself-preservation\b|\bblackmail\w*\b/i],
  ['vehicles', 'Robotaxis and driving', /\bWaymo\b|\brobotaxis?\b|\bself-driving\b|\bdriverless\b|\bAutopilot\b|\bFSD\b|\bautonomous (?:car|vehicle|truck|bus)s?\b|\bZoox\b|\bCruise\b/i],
  ['harm', 'Harm to people', /\bsuicid\w*|\bself-harm\b|\bdelusion\w*|\bpsychos[ie]s\b|\bpsychotic\b|\bmental (?:health )?(?:crisis|breakdown)\b|\bdied\b|\bdeath\b|\bkill(?:ed|s)? (?:him|her|themselves|himself|herself)\b|\bteen\w*\b.{0,40}\b(?:chatbot|AI)\b.{0,40}\b(?:harm|told|encourag\w*)|\bencourag\w* (?:\S+ ){0,3}(?:to )?(?:harm|kill|suicide)\b|\bdangerous (?:advice|diet|medical)\b|\beating disorders?\b|\bAI psychosis\b/i],
  ['scams', 'Scams and fraud', /\bscam\w*|\bfraud\w*|\bphishing\b|\bswindl\w*|\bconned\b|\bcon artists?\b|\bfake (?:worker|job|IT worker|employee)s?\b|\bskimming\b|\bstole \$|\bsextortion\b|\bsteal\w* (?:\S+ ){0,2}(?:credentials|passwords|money|crypto|savings|MFA)\b|\bscammers?\b/i],
  ['images', 'Deepfakes and fake media', /\bdeepfakes?\b|\bnudif\w*|\bundress\w*|\bsexuali[sz]ed\b|\bexplicit (?:images|deepfakes|photos|videos)\b|\bfake (?:images?|photos?|videos?|voices?|audio|ads?|profiles?|news|songs?|band|endorsements?)\b|\bAI fakes?\b|\bAI-generated (?:images?|videos?|photos?|fakes?|nudes?|content|voice|audio)\b|\bvoice clon\w*|\bclon\w* (?:\S+ )?voices?\b|\bimpersonat\w*|\bAI slop\b/i],
  ['security', 'Hacks and leaks', /\bexploit\w*|\bhack\w*|\bbreach\w*|\bvulnerab\w*|\bflaws?\b|\bprompt injection\b|\bjailbreak\w*|\bmalware\b|\bransomware\b|\bleak\w* (?:\S+ ){0,3}(?:data|keys|images|chats|conversations|prompts|information|emails|files|messages|records|secrets|credentials)\b|\b(?:data|keys|chats|conversations|prompts) (?:\S+ )?leak\w*|\bexpos\w* (?:\S+ ){0,3}(?:data|keys|chats|conversations|users|records|secrets)\b|\bzero-day\b|\bcyberattack\w*|\bspyware\b|\bbackdoor\w*|\bsandbox escape\b|\bescapes? (?:\S+ )?sandbox\b|\bAPI keys\b/i],
  ['influence', 'Propaganda and influence', /\binfluence (?:operation|campaign)s?\b|\bpropaganda\b|\bdisinformation\b|\bmisinformation\b|\belection\w*\b.{0,40}\b(?:fake|deepfake|AI-generated|interfer\w*)|\bbot (?:network|farm)s?\b|\bstate-backed\b|\bcovert\b|\bbans? (?:\S+ ){0,3}accounts\b/i],
  ['errors', 'Made-up answers and errors', /\bhallucinat\w*|\bfabricat\w*|\bmade[- ]up\b(?! of)|\bmakes? up\b|\bfake (?:cases|citations|quotes|sources|references|studies|books|reading list)\b|\bnonexistent\b|\bfalse(?:ly)? (?:claims?|information|answers?|accus\w*)\b|\bwrong answers?\b|\bin error\b|\bby mistake\b|\bmistakenly\b|\bbotched\b|\binaccura\w*|\bgot (?:it )?wrong\b|\bgets? (?:\S+ )?wrong\b/i],
  ['bias', 'Bias and offensive output', /\bracis[tm]\b|\bantisemit\w*|\bsexis[tm]\b|\bbias(?:ed)?\b|\bdiscriminat\w*|\boffensive\b|\bhate speech\b|\bMechaHitler\b|\bslur\w*|\bnazi\w*/i],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));

// The product or company involved; the first named wins.
export const PRODUCTS = [
  ['claude', 'Claude (Anthropic)', /\bClaude\b|\bAnthropic\b/i],
  ['chatgpt', 'ChatGPT (OpenAI)', /\bChatGPT\b|\bOpenAI\b|\bCodex\b|\bSora\b|\bGPT-\w+/i],
  ['grok', 'Grok (xAI)', /\bGrok\b|\bxAI\b/i],
  ['gemini', 'Gemini (Google)', /\bGemini\b|\bGoogle\b|\bDeepMind\b|\bAI Overviews?\b|\bWaymo\b/i],
  ['copilot', 'Copilot (Microsoft)', /\bCopilot\b|\bMicrosoft\b|\bGitHub\b/i],
  ['meta', 'Meta AI', /\bMeta\b|\bLlama\b|\bInstagram\b|\bFacebook\b|\bWhatsApp\b/i],
  ['cursor', 'Cursor', /\bCursor\b/i],
  ['replit', 'Replit', /\bReplit\b/i],
  ['deepseek', 'DeepSeek', /\bDeepSeek\b/i],
  ['character', 'Character.AI', /\bCharacter\.?AI\b/i],
  ['tesla', 'Tesla', /\bTesla\b|\bAutopilot\b|\bFSD\b/i],
  ['amazon', 'Amazon', /\bAmazon\b|\bAWS\b|\bAlexa\b/i],
  ['apple', 'Apple', /\bApple\b|\bSiri\b/i],
  ['perplexity', 'Perplexity', /\bPerplexity\b/i],
  ['zoox', 'Zoox', /\bZoox\b/i],
  ['tiktok', 'TikTok', /\bTikTok\b|\bByteDance\b/i],
];
// Waymo is Google's, but a robotaxi crash is its own product.
const VEHICLE_PRODUCTS = [['waymo', 'Waymo', /\bWaymo\b/i], ['tesla', 'Tesla', /\bTesla\b|\bAutopilot\b|\bFSD\b|\bCybercab\b/i], ['zoox', 'Zoox', /\bZoox\b/i], ['cruise', 'Cruise', /\bCruise\b/]];

// What was done about it.
export const RESPONSES = [
  ['paused', 'Paused or pulled', /\bpaus\w*|\bpull(?:s|ed)?\b|\bsuspend\w*|\bdisabl\w*|\bshut(?:s|ting)? down\b|\btak\w* (?:\S+ )?(?:offline|down)\b|\brolls? back\b|\brolled back\b|\brecall\w*|\bhalts?\b|\bhalted\b/i],
  ['banned', 'Banned or blocked', /\bbann?(?:ed|s)?\b|\bblock(?:s|ed)?\b|\bremov\w*|\brestrict\w*/i],
  ['fixed', 'Patched or fixed', /\bpatch\w*|\bfix(?:es|ed)?\b|\bclos\w* (?:\S+ )?(?:hole|flaw|gap|loophole)\b|\bupdat\w* (?:\S+ )?(?:safeguards|guardrails|rules)\b|\bnew safeguards\b|\badds? (?:\S+ )?(?:safeguards|guardrails|parental controls)\b/i],
  ['apology', 'Apology', /\bapolog\w*|\bsorry\b|\badmits?\b|\badmitted\b|\backnowledg\w*/i],
  ['probe', 'Investigation', /\bprob(?:e|es|ed|ing)\b|\binvestigat\w*|\binquiry\b|\bregulators?\b|\bsenators?\b|\bFTC\b|\battorneys? general\b|\bsubpoena\w*/i],
  ['lawsuit', 'Lawsuit', /\bsue[sd]?\b|\bsuing\b|\blawsuits?\b|\bcourt\b|\bcharged\b|\barrest\w*/i],
];
const RESPONSE_LABEL = Object.fromEntries(RESPONSES.map(([k, l]) => [k, l]));

// Headlines about the subject that aren't an incident: advice, products that
// fight the problem, market talk.
const NOT_INCIDENT = /\bhow to\b|\btips?\b|\bways to\b|\bbest (?:defen[cs]e|way)\b|\bprotect (?:yourself|your)\b|\bdetect(?:s|ion|or|ing)?\b|\bfight\w*\b|\bcombat\w*|\bspot\b|\bguard\w*\b|\blaunch\w*|\bunveil\w*|\bintroduc\w*|\braises? \$|\bfunding\b|\bvaluation\b|\bstartup\b|\bpatent\w*|\bstocks?\b|\bshares (?:fall|drop|jump|rise)\b|\binvestors?\b|\bbubble\b|\bhead fake\b|\bwebinar\b|\bpodcast\b|\bsponsored\b|\bjob\b|\bhiring\b|\bweekly\b|\broundup\b|\brecap\b|\bnewsletter\b|\bcourse\b|\bcertif\w*|\bdeals?\b|\bsale\b|\bprice\b|\breview:|\bvs\.?\b|\bcompared\b|\bbenchmark\w*|\bmistake[sn]? (?:to avoid|you)\b|\bcommon mistakes\b|\bcrash course\b|\bmarket crash\b|\bstock market\b|\bcrypto\b|\bbitcoin\b|\bgame\b(?!.*\bhack)|\bleak(?:s|ed)? (?:reveals?|shows?|suggests?|hints?)\b|\bleaked (?:memo|video|audio|roadmap|image|benchmark|specs|render|screenshots?|slides?|documents?|email|plans?)\b|\b(?:specs|release date|roadmap|price) leak\w*|\bmanifesto\b|\bopinion\b|\bagainst (?:scams|fraud|deepfakes|hackers|attacks)\b|\banswer to\b|\bwarn you\b|\braises? [€£$]|\balliance\b|\babsent\b|\b(?:could|might|may|will) go rogue\b|\bneeds answers\b|\bquestions\b|\blet AI\b|\bpre-seed\b|\bseed round\b|\bSeries [A-E]\b|\boutages?\b|\bis down\b|\b(?:border|FBI|ICE|federal|secret|real estate|travel|insurance|free|customs|patrol) agents?\b|\bcan['’]t be (?:deleted|removed)\b/i;
// AI that found a flaw in someone else's code is the defence, not an incident.
const AI_FOUND = /\bAI[- ](?:detected|found|discovered|spotted)\b|\bfound (?:with|by|using) (?:\S+ ){0,3}(?:AI|models?)\b|\bAI (?:helped |helps )?(?:find|found|finds|discover\w*|spot\w*)\b|\bmodels? (?:found|find|finds|discover\w*)\b|\bfound (?:a |two |three )?critical\b/i;
// In a lab or a study rather than in the world.
const LAB = /\bstudy\b|\bstudies\b|\bresearch(?:ers)?\b|\bpaper\b|\bred[- ]team\w*|\btests? (?:show|found|reveal)\w*|\bin (?:a |the )?tests?\b|\bexperiment\w*|\bsimulat\w*|\bsafety (?:report|card|test)s?\b|\bsystem card\b|\bwarns?\b|\bcould\b|\bmight\b|\bcan be (?:tricked|jailbroken|hacked|fooled)\b/i;

export function parseIncident(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (!AI.test(title) || NOT_INCIDENT.test(title) || AI_FOUND.test(title) || /\?$/.test(title)) return null;
  const kind = KINDS.find(([, , re]) => re.test(title))?.[0];
  if (!kind) return null;
  const list = kind === 'vehicles' ? VEHICLE_PRODUCTS : PRODUCTS;
  let product = null;
  let first = Infinity;
  for (const [key, label, re] of list) {
    const m = re.exec(title);
    if (m && m.index < first) { first = m.index; product = { key, label }; }
  }
  const responses = RESPONSES.filter(([, , re]) => re.test(title)).map(([k]) => k);
  return { title, kind, product, responses, lab: LAB.test(title) };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeIncidents(db, now = Date.now(), days = INCIDENT_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);
  const incidents = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue; // English headlines
    const p = parseIncident(r.title);
    if (!p) continue;
    headlines++;
    const source = outlet || r.source || r.site;
    const toks = new Set(tokens(title));
    // Same kind, same product, within five days and about the same thing; or
    // without a product, the same story told the same way within two days.
    const same = incidents.find((x) => x.kind === p.kind && r.at - x.last < (p.product ? 5 : 2) * DAY
      && (p.product ? x.product?.key === p.product.key && overlap(toks, x.toks) >= 0.3 : !x.product && overlap(toks, x.toks) >= 0.5));
    if (same) {
      same.last = r.at;
      same.outlets.add(source);
      for (const k of p.responses) same.responses.add(k);
      for (const t of toks) same.toks.add(t);
      if (!p.lab) same.lab = false;
      if (!same.reports.some((x) => overlap(toks, x.toks) >= 0.7)) same.reports.push({ at: r.at, title, url: r.url, source, toks });
      continue;
    }
    incidents.push({ at: r.at, last: r.at, kind: p.kind, product: p.product, responses: new Set(p.responses), lab: p.lab, title, url: r.url, source, outlets: new Set([source]), toks, reports: [{ at: r.at, title, url: r.url, source, toks }] });
  }

  // Keep what more than one outlet carried, or one outlet on a named product.
  const kept = incidents.filter((x) => x.outlets.size >= 2 || x.product);
  const out = kept.map((x) => ({
    id: `${x.kind}-${x.product?.key || 'ai'}-${new Date(x.at).toISOString().slice(0, 10)}`,
    at: x.at,
    last: x.last,
    kind: x.kind,
    product: x.product,
    responses: [...x.responses],
    lab: x.lab,
    // The headline most outlets would recognise: the first report.
    title: x.title,
    url: x.url,
    source: x.source,
    outlets: x.outlets.size,
    reports: x.reports.slice(0, 10).map(({ toks, ...r }) => r),
  })).sort((a, b) => b.at - a.at);

  // Twelve months by kind.
  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), n: 0, kinds: Object.fromEntries(KINDS.map(([k]) => [k, 0])) });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const x of out) {
    const m = months[mi.get(new Date(x.at).toISOString().slice(0, 7))];
    if (!m) continue;
    m.n++;
    m.kinds[x.kind]++;
  }

  const products = new Map();
  for (const x of out) {
    if (!x.product) continue;
    const p = products.get(x.product.key) || { key: x.product.key, label: x.product.label, n: 0, n90: 0, outlets: 0, kinds: {} };
    p.n++;
    if (x.at >= now - 90 * DAY) p.n90++;
    p.outlets += x.outlets;
    p.kinds[x.kind] = (p.kinds[x.kind] || 0) + 1;
    products.set(p.key, p);
  }

  const in90 = out.filter((x) => x.at >= now - 90 * DAY);
  const prev90 = out.filter((x) => x.at < now - 90 * DAY && x.at >= now - 180 * DAY);
  const answered = out.filter((x) => x.responses.length);
  return {
    generatedAt: now,
    days,
    headlines,
    incidents: out.slice(0, 400),
    months,
    kinds: KINDS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.kind === key).length, n90: in90.filter((x) => x.kind === key).length })),
    products: [...products.values()].sort((a, b) => b.n - a.n).slice(0, 14),
    responses: RESPONSES.map(([key, label]) => ({ key, label, n: out.filter((x) => x.responses.includes(key)).length })),
    labels: { kinds: KIND_LABEL, responses: RESPONSE_LABEL },
    stats: {
      incidents: out.length,
      n90: in90.length,
      prev90: prev90.length,
      agents90: in90.filter((x) => x.kind === 'agents').length,
      agentsPrev90: prev90.filter((x) => x.kind === 'agents').length,
      answeredShare: out.length ? answered.length / out.length : 0,
      lab: out.filter((x) => x.lab).length,
      widest: [...in90].sort((a, b) => b.outlets - a.outlets)[0] || null,
    },
  };
}

export const incidentsQuery = () => cachedJob('incidents', { kind: 'incidents' }, TTL_MS);
