// AI and jobs: the layoffs companies tie to AI, read from a year of
// headlines. A cut names a company ("Atlassian lays off 10% of its global
// workforce", "Barclays plans 5,000 job cuts as AI push reshapes
// operations"), sometimes a headcount or a share of staff, and why AI comes
// into it: the work is now done by AI, the money goes to AI instead, a
// refocus on AI, or a company saying it was nothing to do with AI. The
// rest of the coverage is the argument about it: reports that AI is
// driving cuts, and people who call it an excuse.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { nameBefore } from './deals.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const JOBS_DAYS = 365;

const FTS = 'title:(layoff* OR "lay off" OR "lays off" OR "laid off" OR "laying off" OR "job cuts" OR "cut jobs" OR "cuts jobs" OR "cutting jobs" OR "jobs cut" OR "slash jobs" OR "slashes jobs" OR redundanc* OR headcount OR "hiring freeze" OR workforce OR "job losses" OR "jobs lost" OR "job loss" OR "white-collar" OR "entry-level" OR "replace workers" OR "replacing workers" OR "replaced by AI" OR "jobs") AND title:(AI OR "artificial intelligence" OR automation OR automating OR chatbot* OR agents OR agentic)';

export const AI = /\bAI\b|artificial intelligence|\bautomat\w+|chatbots?|\bagents?\b|\bagentic\b|\bAI-\w+/i;
// The subject has to be work.
const WORK = /\blay(?:s|ing)? off\b|\blaid off\b|\blayoffs?\b|\bjob(?:s)? cuts?\b|\bcut(?:s|ting)? (?:\S+ )?(?:jobs|roles|positions|staff|workers|employees|headcount)\b|\bslash\w* (?:\S+ )?(?:jobs|roles|staff|workforce|headcount)\b|\baxe[sd]? (?:\S+ )?(?:jobs|roles|staff)\b|\bredundanc|\bheadcount\b|\bhiring freeze\b|\bworkforce\b|\bjob (?:loss|losses|market|seekers|security)\b|\bjobs? (?:lost|losses|crisis|apocalypse)\b|\bwhite-collar\b|\bentry-level\b|\bunemploy\w*|\breplac\w* (?:\S+ )?(?:workers|employees|staff|humans|people|jobs)\b|\breplaced by AI\b|\bjobs\b|\bworkers\b|\bemployees\b|\bcareers?\b/i;
// Other senses and topics that share the words.
const NOT_JOBS = /\b(?:long-running|background|batch|async\w*|scheduled|cron|training|inference|GPU) (?:\S+ )?jobs\b|\bSteve Jobs\b|\bjobs? (?:to be done|scheduler|queue)\b|\bbatch jobs\b|\bcron\b|\bjob applications? (?:tool|bot)\b|\bpaint jobs?\b|\bnose jobs?\b|\bjobs report\b(?!.*\bAI\b)|\bjobs (?:numbers|data)\b(?!.*\bAI\b)|\bresume\b|\bcover letters?\b|\binterview tips\b|\bhow to (?:get|find|land)\b|\bbest (?:jobs|careers)\b|\bjob boards?\b/i;

// A company announcing cuts: "X lays off", "X to cut 5,000 jobs", "X plans
// job cuts", "X is slashing its headcount", "layoffs at X".
const CUT_VERB = /\s(?:is |are |will |to |plans to |set to |poised to |weighs? |weighing |considers? |considering |reportedly |quietly |abruptly |now |just |also |again )*(?:lays? off|laid off|laying off|lay off|cuts?|cutting|slash(?:es|ing)?|axe[sd]?|axing|eliminat(?:es|ing|ed)|shed(?:s|ding)?|trims?|trimming|plans? (?:\S+ )?(?:job cuts|layoffs)|announces? (?:\S+ )?(?:job cuts|layoffs)|(?:job cuts|layoffs) (?:hit|at|of))\b/i;
const CUT_OBJ = /\b(?:jobs?|roles|positions|staff|staffers|workers|employees|workforce|people|headcount|layoffs|job cuts)\b/i;
const NOT_COMPANY = /^(?:AI|The|This|That|A|An|Why|How|What|When|Who|Tech|Companies|Employers|CEOs?|Bosses|Firms|Businesses|Startups|Banks|Executives|Workers|Employees|Layoffs|Report|Survey|Study|Data|Analysis|New|Here|More|Most|Some|Many|Big Tech|Silicon Valley|Wall Street|America|US|U\.S\.|UK|India|China|Europe|Government|Federal|Congress|Trump|It|They|We|You|I|He|She|Opinion|Exclusive|Breaking|Update|Watch|Listen|Podcast|Video|Live|Analysis|Explainer|Gen Z|Millennials|Graduates|Agents|Robots|Automation|Machines|Chatbots|Humans|People|Microsoft and|Google and)$/;
const NOT_LEAD = /^(?:As|From|Could|Pick|Dreading|Should|Would|Will|Can|If|After|Before|While|Amid|Inside|Read|With|Without|Despite|Even|Fearing|Facing|Is|Are|Do|Does|Did)\b/;
const LAYOFFS_AT = /\b(?:layoffs?|job cuts|cuts) at ([A-Z][\w&.'’-]*(?: [A-Z][\w&.'’-]*){0,3})/;
const COMPANY_LAYOFFS = /^([A-Z][\w&.-]*(?: [A-Z][\w&.-]*){0,2})(?:['’]s)?(?: [A-Z]{2,})? (?:layoffs|job cuts|AI layoffs|AI-driven layoffs|AI job cuts)\b/;

// Why AI comes into it, most specific first.
export const REASONS = [
  ['denied', 'Says it isn’t AI', /\bAI isn['’]t to blame\b|\bnot to blame\b|\bnothing to do with AI\b|\bnot (?:about|because of|due to|driven by) AI\b|\bweren['’]t (?:about|because of) (?:cutting costs or )?AI\b|\bisn['’]t (?:about|because of) AI\b|\bnot AI\b|\bdenies\b.*\bAI\b|\b(?:it['’]s|its) culture\b/i],
  ['funding', 'To pay for AI', /\b(?:offset|fund|finance|pay for|free up (?:cash|money) for)\b.{0,30}\bAI\b|\bAI (?:spending|spend|costs?|investments?|capex|race|bills?|budget)\b|\bpours?\b.{0,30}\bAI\b|\bpouring\b.{0,30}\bAI\b|\bspend\w* (?:\S+ ){0,3}on AI\b|\bbillions? (?:\S+ ){0,3}(?:into|on) AI\b/i],
  ['refocus', 'Refocus on AI', /\brefocus\w*\b|\bpivot\w*\b|\bAI[- ]first\b|\bshift\w* (?:\S+ ){0,3}(?:resources|focus|priorities)\b|\breorgani[sz]\w*|\brestructur\w*|\breshap\w*|\bAI push\b|\bAI era\b|\bage of AI\b|\bAI transformation\b|\bAI strategy\b/i],
  ['replaced', 'AI does the work', /\bbecause of AI\b|\bciting AI\b|\bcites? AI\b|\bblam\w* (?:\S+ ){0,3}AI\b|\bdue to AI\b|\bAI[- ](?:driven|led|related|fueled|fuelled|powered|induced)\b|\breplac\w*\b|\bautomat\w*|\bAI (?:has|is|can) (?:changed|taking|doing|now|replac)|\b(?:AI|agents|chatbots|bots) (?:took|take|takes|now do|do the work)\b|\battribut\w*\b.{0,40}\bAI\b|\bAI (?:tools|agents) (?:can|now|do)\b|\bintelligence tools\b|\breasons?\b|\bhand\w* (?:\S+ ){0,2}(?:over )?to AI\b|\bturns? to AI\b|\breliance on AI\b|\bAI productivity\b|\befficienc\w*|\breduce costs with AI\b|\bAI (?:has|had) (?:changed|on)\b|\bimpact AI\b/i],
  ['cited', 'AI in the picture', /./],
];
const REASON_LABEL = Object.fromEntries(REASONS.map(([k, l]) => [k, l]));

// Commentary: is AI really taking the jobs?
const SKEPTIC = /\bexcuse\b|\bAI[- ]washing\b|\bwashing\b|\bfarce\b|\bmyth\b|\bscapegoat\b|\bno (?:real )?evidence\b|\bzero evidence\b|\bnot (?:really|actually) (?:about|because of|taking)\b|\bblaming AI\b|\bhiding behind\b|\bwould(?:'ve| have) made anyway\b|\bregret\w*\b|\bremorse\b|\brestor\w*\b|\brehir\w*|\bhir\w* (?:them |workers )?back\b|\boverstaffed\b|\bcover (?:for|story)\b|\boverhyped\b|\bovers?tat\w*\b|\bdumb\b|\bshut up\b|\bperformative\b|\bisn['’]t (?:taking|killing|stealing)\b|\bnot taking\b|\bnot (?:the|a) (?:reason|cause)\b|\bhasn['’]t (?:taken|killed|cost)\b|\bmay have (?:finally )?ended\b/i;
// The other side has to be about work going away.
const ALARM = /\blayoffs?\b|\blay(?:s|ing)? off\b|\blaid off\b|\bjob (?:cuts|loss|losses)\b|\bjobs? (?:lost|losses|apocalypse|crisis)\b|\bcut(?:s|ting)? (?:\S+ )?jobs\b|\breplac\w*|\bdisplac\w*|\beliminat\w*|\bwip\w* out\b|\b(?:taking|take|takes|took|coming for|steal\w*|kill\w*|destroy\w*) (?:\S+ ){0,2}(?:jobs|work|roles|careers)\b|\bvanish\w*|\bdisappear\w*|\bshrink\w*|\bfewer (?:jobs|workers|hires)\b|\bunemploy\w*|\bbloodbath\b|\bat risk\b|\bthreat\w* (?:to )?(?:\S+ )?jobs\b|\bhiring (?:freeze|slowdown|drops?|falls?)\b|\bstop(?:ped)? hiring\b|\bno longer hir\w*|\bjobless\w*/i;

// The kinds of work named in the coverage.
export const ROLES = [
  ['support', 'Customer service', /\bcustomer (?:service|support|care)\b|\bcall cent(?:er|re)s?\b|\bsupport (?:staff|agents|workers|roles)\b|\bcontact cent(?:er|re)s?\b/i],
  ['engineers', 'Software engineers', /\b(?:software )?engineers?\b|\bdevelopers?\b|\bprogrammers?\b|\bcoders?\b|\bcoding jobs\b|\btech workers\b/i],
  ['entry', 'Entry-level and graduates', /\bentry-level\b|\bgraduates?\b|\bgrads\b|\bjunior\b|\binterns?\b|\bfirst jobs?\b|\bgen z\b|\byoung (?:workers|people|men|women)\b/i],
  ['hr', 'HR and recruiting', /\bHR\b|\bhuman resources\b|\brecruit\w*/i],
  ['creative', 'Writers, artists and translators', /\bwriters?\b|\bcopywriters?\b|\btranslators?\b|\bjournalists?\b|\bartists?\b|\bdesigners?\b|\billustrators?\b|\bactors?\b|\bvoice actors?\b|\bcontent (?:creators?|moderators?)\b|\bmoderators?\b/i],
  ['office', 'Back office and finance', /\banalysts?\b|\baccountants?\b|\bbank(?:ers|ing) (?:staff|jobs)\b|\bback[- ]office\b|\boperations staff\b|\bclerical\b|\badministrative\b|\bparalegals?\b|\blawyers?\b|\bconsultants?\b/i],
  ['managers', 'Middle managers', /\bmiddle manag\w*|\bmanagers\b|\bmanagement layers?\b/i],
  ['whitecollar', 'White-collar work', /\bwhite-collar\b|\boffice (?:workers|jobs)\b|\bknowledge workers\b/i],
];

const NUM_WORD = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, several: 0, hundreds: 0, thousands: 0, dozens: 0 };
const PEOPLE = '(?:jobs|roles|positions|workers|employees|staff|staffers|people|corporate (?:jobs|roles|employees|workers)|white-collar (?:jobs|roles)|tech (?:jobs|workers))';
const COUNT = new RegExp(`(?:^|[^\\w$.,])(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s?(k|thousand|million)?\\+?\\s(?:more |new |of its |of their |corporate |office |more than )?${PEOPLE}\\b`, 'i');
const PCT = /\b(\d{1,2}(?:\.\d)?)\s?(?:%|percent)\s(?:of (?:its |their |the )?(?:remaining )?(?:global |corporate |total )?(?:staff|workforce|workers|employees|jobs|headcount|employees)|(?:of )?(?:its |the )?(?:global |corporate )?(?:workforce|staff|headcount))\b/i;
const STAFF = '(?:of )?(?:its|the|their|his|her) (?:global |corporate |entire )?(?:staff|workforce|employees|headcount)\\b';
const SHARE_WORDS = [[new RegExp(`\\b(?:nearly|almost|about) half ${STAFF}|\\bhalf ${STAFF}`, 'i'), 45], [new RegExp(`\\b(?:almost |nearly )?(?:a|one) quarter ${STAFF}`, 'i'), 25], [new RegExp(`\\b(?:a|one) third ${STAFF}`, 'i'), 33]];

const BY = /\b(?:workforce|staff|headcount) by (?:about |nearly |around )?(\d{1,3}(?:,\d{3})+|\d+)\b(k|thousand)?/i;

export function countOf(title) {
  const m = COUNT.exec(title) || BY.exec(title);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'thousand') n *= 1e3;
  if (unit === 'million') n *= 1e6;
  // A year ("2026 jobs") or a survey's share isn't a headcount.
  if (!n || (n >= 1990 && n <= 2100 && !m[1].includes(','))) return null;
  return n >= 10 && n <= 2e6 ? Math.round(n) : null;
}

export function shareOf(title) {
  const m = PCT.exec(title);
  if (m) return Number(m[1]);
  for (const [re, v] of SHARE_WORDS) if (re.test(title)) return v;
  return null;
}

// Bosses named in place of their company.
const BOSSES = { 'jack dorsey': 'Block', dorsey: 'Block', 'mark zuckerberg': 'Meta', zuckerberg: 'Meta', 'andy jassy': 'Amazon', jassy: 'Amazon', 'satya nadella': 'Microsoft', nadella: 'Microsoft', 'sundar pichai': 'Google', pichai: 'Google', 'marc benioff': 'Salesforce', benioff: 'Salesforce', 'elon musk': 'X', 'brian armstrong': 'Coinbase', 'tim sweeney': 'Epic Games', 'evan spiegel': 'Snap', 'matthew prince': 'Cloudflare' };

const cleanName = (raw) => {
  if (!raw) return null;
  // "Block CEO Jack Dorsey" -> "Block".
  const name = raw.replace(/\s+(?:CEO|chief|boss|founder|co-founder|chairman)\b.*$/i, '').trim();
  if (BOSSES[name.toLowerCase()]) return BOSSES[name.toLowerCase()];
  if (/^(?:CEO|Billionaire|Founder)\b/.test(name)) return null;
  const n = name.replace(/^(?:AI|Tech|Fintech|Software|Chip|Bank|Retail|Telecom|Gaming|Media|Edtech) (?=[A-Z])/, '').trim();
  if (!n || n.length < 2 || n.length > 32 || /\.\s|\bAPI\b|\bAI\b/.test(n) || NOT_LEAD.test(n) || NOT_COMPANY.test(n) || NOT_COMPANY.test(n.split(' ')[0]) || /^\d/.test(n)) return null;
  return n;
};

export function companyOf(title) {
  let m = COMPANY_LAYOFFS.exec(title);
  if (m) {
    const n = cleanName(m[1]);
    if (n) return n;
  }
  m = CUT_VERB.exec(title);
  if (m && CUT_OBJ.test(title.slice(m.index)) || (m && /lays? off|laid off|laying off|layoffs/i.test(m[0]))) {
    const before = title.slice(0, m.index);
    // "Jack Dorsey lays off 40% of Block": the company follows the share.
    const of = /\bof ([A-Z][\w&.'’-]*(?: [A-Z][\w&.'’-]*){0,2})\b/.exec(title.slice(m.index));
    const person = /^(?:CEO |Billionaire |Founder )?[A-Z][a-z]+ [A-Z][a-z]+$/.test(before.trim().split(/[:,]/).pop().trim());
    if (person && of) {
      const n = cleanName(of[1]);
      if (n) return n;
    }
    const n = cleanName(nameBefore(before.split(/[:;|,]/).pop()));
    if (n && !person) return n;
  }
  m = LAYOFFS_AT.exec(title);
  if (m) return cleanName(m[1]);
  return null;
}

const keyOf = (name) => name.toLowerCase().replace(/[’']s$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

// One headline: a company's cut, or a piece of the argument, or neither.
export function parseJobs(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (!AI.test(title) || !WORK.test(title) || NOT_JOBS.test(title)) return null;
  const roles = ROLES.filter(([, , re]) => re.test(title)).map(([k]) => k);
  const reason = REASONS.find(([, , re]) => re.test(title))[0];
  const company = /\?$/.test(title) ? null : companyOf(title);
  const count = countOf(title);
  const share = shareOf(title);
  const isCut = !!company && (/lay|laid|layoff|cut|slash|axe|axing|eliminat|shed|trim/i.test(title));
  const planned = /\b(?:weigh\w*|consider\w*|plans?|planning|to (?:cut|lay|slash|axe|eliminate|shed)|will (?:cut|lay|slash)|poised|reportedly|could|may|might|prepares?|preparing|eyes|mulls?)\b/i.test(title);
  const stance = SKEPTIC.test(title) ? 'skeptic' : ALARM.test(title) ? 'alarm' : null;
  return {
    title,
    kind: isCut ? 'cut' : stance ? 'debate' : 'other',
    company: isCut ? { key: keyOf(company), label: company } : null,
    count: isCut ? count : null,
    share: isCut ? share : null,
    reason,
    planned,
    stance,
    roles,
  };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeJobs(db, now = Date.now(), days = JOBS_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);
  const companies = new Map();
  const debate = [];
  const roleItems = new Map(ROLES.map(([k]) => [k, []]));
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue; // English headlines
    const p = parseJobs(r.title);
    if (!p || p.kind === 'other' && !p.roles.length) continue;
    headlines++;
    const source = outlet || r.source || r.site;
    const toks = new Set(tokens(title));
    for (const k of p.roles) {
      const list = roleItems.get(k);
      const same = list.find((e) => r.at - e.last < 2 * DAY && overlap(toks, e.toks) >= 0.6);
      if (same) { same.outlets.add(source); same.last = r.at; } else list.push({ at: r.at, last: r.at, title, url: r.url, source, outlets: new Set([source]), toks });
    }
    if (p.kind === 'cut') {
      let c = companies.get(p.company.key);
      if (!c) {
        c = { key: p.company.key, label: p.company.label, labels: new Map(), events: [] };
        companies.set(c.key, c);
      }
      c.labels.set(p.company.label, (c.labels.get(p.company.label) || 0) + 1);
      // A round of cuts is reported for weeks ("weighing", then "lays off",
      // then the fallout): one event while it keeps coming within 3 weeks.
      let e = c.events.find((x) => r.at - x.last < 21 * DAY);
      if (!e) {
        e = { at: r.at, last: r.at, count: null, share: null, reasons: new Map(), planned: true, outlets: new Set(), reports: [] };
        c.events.push(e);
      }
      e.last = r.at;
      e.outlets.add(source);
      e.reasons.set(p.reason, (e.reasons.get(p.reason) || 0) + 1);
      if (!p.planned) e.planned = false;
      if (p.count) e.counts = [...(e.counts || []), p.count];
      if (p.share) e.share = Math.max(e.share || 0, p.share);
      const same = e.reports.find((x) => overlap(toks, x.toks) >= 0.6);
      if (same) same.outlets.add(source);
      else e.reports.push({ at: r.at, title, url: r.url, source, outlets: new Set([source]), toks });
      continue;
    }
    if (p.kind === 'debate') {
      const same = debate.find((e) => e.stance === p.stance && r.at - e.last < 2 * DAY && overlap(toks, e.toks) >= 0.6);
      if (same) { same.outlets.add(source); same.last = r.at; continue; }
      debate.push({ at: r.at, last: r.at, stance: p.stance, title, url: r.url, source, outlets: new Set([source]), toks, roles: p.roles });
    }
  }

  // Why, for an event: the most specific reason any of its reports gives
  // ("cited" only when none says more).
  const ORDER = REASONS.map(([k]) => k);
  const reasonOf = (e) => {
    const named = [...e.reasons].filter(([k]) => k !== 'cited').sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
    return named[0]?.[0] || 'cited';
  };
  // The headcount most outlets agree on: the most repeated figure, else the
  // largest one two reports give, else a lone figure.
  const countFor = (e) => {
    if (!e.counts?.length) return null;
    const tally = new Map();
    for (const n of e.counts) tally.set(n, (tally.get(n) || 0) + 1);
    const best = [...tally].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    return best[0];
  };

  const cuts = [];
  for (const c of companies.values()) {
    const label = [...c.labels].sort((a, b) => b[1] - a[1])[0][0];
    for (const e of c.events) {
      // One outlet once with no figure is too thin to count as a round of cuts.
      if (e.outlets.size < 2 && !e.counts && !e.share && reasonOf(e) === 'cited') continue;
      cuts.push({
        id: `${c.key}--${new Date(e.at).toISOString().slice(0, 7)}`,
        company: { key: c.key, label },
        at: e.at,
        last: e.last,
        count: countFor(e),
        share: e.share,
        reason: reasonOf(e),
        status: e.planned ? 'planned' : 'announced',
        outlets: e.outlets.size,
        reports: e.reports.slice(0, 12).map(({ toks, outlets, ...x }) => ({ ...x, outlets: outlets.size })),
      });
    }
  }
  cuts.sort((a, b) => b.at - a.at);

  // Twelve months: rounds of cuts by reason, and the jobs they name.
  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), jobs: 0, rounds: 0, reasons: Object.fromEntries(ORDER.map((k) => [k, 0])), alarm: 0, skeptic: 0 });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  const monthOf = (at) => months[mi.get(new Date(at).toISOString().slice(0, 7))];
  for (const c of cuts) {
    const m = monthOf(c.at);
    if (!m) continue;
    m.rounds++;
    m.reasons[c.reason]++;
    m.jobs += c.count || 0;
  }
  for (const d of debate) {
    const m = monthOf(d.at);
    if (m) m[d.stance]++;
  }

  const byCompany = new Map();
  for (const c of cuts) {
    const x = byCompany.get(c.company.key) || { key: c.company.key, label: c.company.label, rounds: 0, jobs: 0, last: 0, reasons: {} };
    x.rounds++;
    x.jobs += c.count || 0;
    x.last = Math.max(x.last, c.at);
    x.reasons[c.reason] = (x.reasons[c.reason] || 0) + 1;
    byCompany.set(x.key, x);
  }

  const slim = ({ toks, outlets, ...x }) => ({ ...x, outlets: outlets.size });
  const recent = (list) => list.sort((a, b) => b.outlets.size - a.outlets.size || b.at - a.at);
  const in90 = cuts.filter((c) => c.at >= now - 90 * DAY);
  const tied = (list) => list.filter((c) => ['replaced', 'refocus'].includes(c.reason)).length;
  return {
    generatedAt: now,
    days,
    headlines,
    cuts: cuts.slice(0, 200),
    months,
    companies: [...byCompany.values()].sort((a, b) => b.jobs - a.jobs || b.rounds - a.rounds).slice(0, 20),
    reasons: REASONS.map(([key, label]) => ({ key, label, n: cuts.filter((c) => c.reason === key).length })),
    debate: {
      alarm: recent(debate.filter((d) => d.stance === 'alarm')).slice(0, 40).map(slim).sort((a, b) => b.at - a.at),
      skeptic: recent(debate.filter((d) => d.stance === 'skeptic')).slice(0, 40).map(slim).sort((a, b) => b.at - a.at),
    },
    roles: ROLES.map(([key, label]) => {
      const list = roleItems.get(key);
      return { key, label, n: list.length, n90: list.filter((e) => e.at >= now - 90 * DAY).length, items: recent([...list]).slice(0, 12).map(slim).sort((a, b) => b.at - a.at) };
    }).filter((r) => r.n),
    labels: REASON_LABEL,
    stats: {
      rounds: cuts.length,
      companies: byCompany.size,
      jobs: cuts.reduce((s, c) => s + (c.count || 0), 0),
      jobs90: in90.reduce((s, c) => s + (c.count || 0), 0),
      rounds90: in90.length,
      // Of the rounds of cuts where a reason is given, the share that say AI
      // does the work or the company is refocusing on it.
      tiedShare: cuts.length ? tied(cuts) / Math.max(1, cuts.filter((c) => c.reason !== 'cited').length) : 0,
      skepticShare: debate.length ? debate.filter((d) => d.stance === 'skeptic').length / debate.length : 0,
      biggest: [...cuts].filter((c) => c.count).sort((a, b) => b.count - a.count)[0] || null,
    },
  };
}

export const jobsQuery = () => cachedJob('jobs', { kind: 'jobs' }, TTL_MS);
