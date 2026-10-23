// AI in science and health: a year of headlines where AI meets research,
// medicine and discovery. Each headline gets a field (life sciences, health
// and medicine, maths and physics, earth and materials), what happened (a
// discovery, a study, a new tool, a deal, or a concern) and the lab when one
// is named. Reports of the same thing within days are one event; the field
// mix is followed month by month.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const SCIENCE_DAYS = 365;

const FTS = 'title:(protein OR proteins OR AlphaFold OR biology OR genome OR genomics OR DNA OR RNA OR enzyme OR antibody OR antibodies OR molecule OR molecules OR drug OR drugs OR pharma OR "clinical trial" OR "clinical trials" OR cancer OR tumor OR tumour OR disease OR diseases OR diagnosis OR diagnose OR diagnoses OR medical OR medicine OR doctors OR doctor OR hospital OR hospitals OR patients OR radiology OR Alzheimer OR math OR mathematics OR mathematician OR mathematicians OR theorem OR proof OR proofs OR conjecture OR Erdos OR olympiad OR physics OR quantum OR fusion OR astronomy OR telescope OR weather OR climate OR hurricane OR wildfire OR chemistry OR materials OR catalyst OR superconductor OR scientific OR scientists OR science OR discovery OR discoveries OR lab OR biotech)';

// Fields, first match wins; four series and their parts.
export const FIELDS = [
  ['math', 'physics', /\bmath(?:s|ematics|ematical|ematicians?)?\b|\btheorems?\b|\bproofs?\b|\bconjectures?\b|\bErd[oő]s\b|\bolympiad\b|\bIMO\b|\bLean\b(?= 4| proof|-proof)/i],
  ['physics', 'physics', /\bphysics\b|\bquantum\b|\bfusion\b|\bparticles?\b|\bastronom\w*|\btelescopes?\b|\bgalax\w*|\bcosmolog\w*|\bplasma\b/i],
  ['bio', 'life', /\bproteins?\b|\bAlphaFold\b|\bbiolog\w*|\bgenom\w*|\bDNA\b|\bRNA\b|\bgenes?\b|\bgenetic\w*|\benzymes?\b|\bantibod\w*|\bmolecul\w*|\bcells?\b|\bbiotech\w*|\bvirtual cell\b|\bvirus\w*|\bbacteria\w*/i],
  ['drugs', 'life', /\bdrugs?\b|\bdrug discovery\b|\bpharma\w*|\bclinical trials?\b|\btherapeut\w*|\bcompounds?\b|\bmedicines?\b|\bFDA\b/i],
  ['health', 'health', /\bdiagnos\w*|\bcancer\w*|\btumou?rs?\b|\bpatients?\b|\bdoctors?\b|\bphysicians?\b|\bhospitals?\b|\bmedical\b|\bradiolog\w*|\bclinic\w*|\bdiseases?\b|\bhealth ?care\b|\bAlzheimer\w*|\bheart\b|\bscans?\b|\bsurg\w*|\bnurses?\b|\bmental health\b|\bstroke\b|\bdiabet\w*/i],
  ['climate', 'earth', /\bweather\b|\bclimate\b|\bhurricanes?\b|\bstorms?\b|\bfloods?\b|\bwildfires?\b|\bearthquakes?\b|\bEarth\b|\bocean\w*|\bforecast\w* (?:\S+ )?(?:weather|storms?|rain)\b/i],
  ['materials', 'earth', /\bmaterials?\b|\bchemi\w*|\bcatalysts?\b|\bsuperconduct\w*|\bbatter(?:y|ies)\b|\bcrystals?\b|\balloys?\b/i],
];
export const GROUPS = [['life', 'Life sciences and drugs'], ['health', 'Health and medicine'], ['physics', 'Maths and physics'], ['earth', 'Earth, climate and materials']];
const FIELD_LABEL = { math: 'Maths', physics: 'Physics and space', bio: 'Biology', drugs: 'Drug discovery', health: 'Health and medicine', climate: 'Weather and climate', materials: 'Materials and chemistry' };
const GROUP_LABEL = Object.fromEntries(GROUPS);

export const KINDS = [
  ['concern', 'Concerns and failures', /\bwarn\w*|(?<!\b(?:cancer|disease|stroke|heart|health|genetic|dementia|suicide|fall|readmission|mortality) )\brisks?\b(?! (?:of|factors?|assessment|prediction|scores?|stratification))|\bfail\w*|\bwrong\b|\bmisdiagnos\w*|\bharm\w*|\berrors?\b|\blawsuits?\b|\bsue[sd]?\b|\bbias\w*|\bconcerns?\b|\bdangerous\b|\bunsafe\b|\bworse\b|\bdeaths?\b|\bdenied\b|\bdenials?\b|\bbacklash\b|\bprobe\b|\bisn['’]t adding up\b|\boverhyped\b|\bslop\b|\bfake\b|\bfabricat\w*/i],
  ['deal', 'Money and deals', /\braises?\b|\braised\b|\bfunding\b|\bacquir\w*|\binvest\w*|\bvaluation\b|\bIPO\b|\bpartner\w*|\bdeal\b|\bcollaborat\w*|\bteams? up\b|\bjoins? forces\b/i],
  ['discovery', 'Discoveries and results', /\bdiscover\w*|\bfinds?\b|\bfound\b|\bsolv\w*|\bproves?\b|\bproved\b|\bproofs? of\b|\bbreakthroughs?\b|\bidentif\w*|\bpredicts?\b|\buncover\w*|\breveals?\b|\bdesign\w* (?:\S+ ){0,2}(?:proteins?|drugs?|antibod\w*|molecules?|enzymes?)\b|\bnew (?:antibiotic|drug|material|protein|compound)s?\b|\bfirst (?:\S+ ){0,2}(?:discovered|designed)\b|\bbeats? (?:doctors|radiologists|physicians|experts|mathematicians)\b|\boutperforms? (?:doctors|radiologists|physicians|experts)\b|\bmatches? (?:doctors|experts)\b|\bmilestone\b/i],
  ['tool', 'New tools and models', /\blaunch\w*|\breleas\w*|\bunveil\w*|\bintroduc\w*|\bdebut\w*|\bopen-sourc\w*|\bmodels?\b|\bplatforms?\b|\bagents?\b|\btools?\b|\bapp\b|\bassistant\b|\bfoundation model\b|\brolls? out\b|\bavailable\b/i],
  ['study', 'Studies and trials', /\bstud(?:y|ies)\b|\bresearch\w*|\bpaper\b|\btrials?\b|\btested\b|\btests?\b|\baccura\w*|\bevaluat\w*|\bbenchmarks?\b|\bscientists?\b|\bexperiment\w*/i],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));

export const LABS = [
  ['deepmind', 'Google DeepMind', /\bDeepMind\b|\bAlphaFold\b|\bAlpha(?:Proof|Evolve|Genome|Geometry|Earth)\b|\bIsomorphic\b|\bGoogle\b/],
  ['openai', 'OpenAI', /\bOpenAI\b|\bChatGPT\b|\bGPT-[\w.-]+/],
  ['anthropic', 'Anthropic', /\bAnthropic\b|\bClaude\b/],
  ['microsoft', 'Microsoft', /\bMicrosoft\b|\bMatterGen\b|\bMatterSim\b/],
  ['meta', 'Meta', /\bMeta\b/],
  ['nvidia', 'Nvidia', /\bNvidia\b|\bNVIDIA\b|\bBioNeMo\b|\bEarth-2\b/],
  ['amazon', 'Amazon', /\bAmazon\b|\bAWS\b/],
  ['xai', 'xAI', /\bxAI\b|\bGrok\b/],
  ['mistral', 'Mistral', /\bMistral\b/],
];
const NOT = /\bdata scien\w*|\bcomputer science\b|\bpolitical science\b|\bscience fiction\b|\bsci-fi\b|\bstocks?\b|\bshares\b|\bpatents?\b|\bPaper page\b|\barXiv\b|\bpodcast\b|\bwebinar\b|\bnewsletter\b|\bjobs?\b|\bcourses?\b|\bdegree\b|\bstudents?\b|\bphysical AI\b|\bphysical world\b|\bmath (?:homework|class)\b|\bdeepfake\w*|\bdata cent(?:er|re)s?\b|\bpower\b|\belectricity\b|\bhow to\b|\?$/i;

export function parseScience(rawTitle) {
  const { title } = splitOutlet(rawTitle);
  if (NOT.test(title) || !isAiRelated(title)) return null;
  const field = FIELDS.find(([, , re]) => re.test(title));
  if (!field) return null;
  const kind = KINDS.find(([, , re]) => re.test(title))?.[0];
  if (!kind) return null;
  let lab = null;
  let first = Infinity;
  for (const [key, label, re] of LABS) {
    const m = re.exec(title);
    if (m && m.index < first) { first = m.index; lab = { key, label }; }
  }
  return { title, field: field[0], group: field[1], kind, lab };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeScience(db, now = Date.now(), days = SCIENCE_DAYS) {
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, now - days * DAY, now + 5 * 60e3);
  const events = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue;
    const p = parseScience(r.title);
    if (!p) continue;
    headlines++;
    const source = outlet || r.source || r.site;
    const toks = new Set(tokens(title));
    const same = events.find((x) => x.group === p.group && r.at - x.last < 5 * DAY && overlap(toks, x.toks) >= (x.lab && p.lab && x.lab.key === p.lab.key ? 0.35 : 0.5));
    if (same) {
      same.last = r.at;
      same.outlets.add(source);
      for (const t of toks) same.toks.add(t);
      // A discovery reported anywhere makes the event a discovery.
      if (p.kind === 'discovery' && (same.kind === 'tool' || same.kind === 'study')) same.kind = 'discovery';
      same.lab ||= p.lab;
      if (!same.reports.some((x) => overlap(toks, x.toks) >= 0.7)) same.reports.push({ at: r.at, title, url: r.url, source, toks });
      continue;
    }
    events.push({ ...p, at: r.at, last: r.at, url: r.url, source, outlets: new Set([source]), toks, reports: [{ at: r.at, title, url: r.url, source, toks }] });
  }

  // A named lab, a discovery or concern, or a story two outlets carried.
  const out = events.filter((x) => x.lab || x.outlets.size >= 2 || x.kind === 'discovery' || x.kind === 'concern').map((x) => ({
    id: `${x.field}-${x.kind}-${new Date(x.at).toISOString().slice(0, 10)}-${[...x.toks].slice(0, 2).join('-')}`.replace(/[^a-z0-9-]/gi, '').slice(0, 70),
    at: x.at,
    last: x.last,
    field: x.field,
    group: x.group,
    kind: x.kind,
    lab: x.lab,
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
    months.push({ m: d.toISOString().slice(0, 7), n: 0, groups: Object.fromEntries(GROUPS.map(([k]) => [k, 0])), discoveries: 0 });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const x of out) {
    const m = months[mi.get(new Date(x.at).toISOString().slice(0, 7))];
    if (!m) continue;
    m.n++;
    m.groups[x.group]++;
    if (x.kind === 'discovery') m.discoveries++;
  }
  const in90 = (x) => x.at >= now - 90 * DAY;
  const prev90 = (x) => x.at < now - 90 * DAY && x.at >= now - 180 * DAY;
  const labs = LABS.map(([key, label]) => {
    const list = out.filter((x) => x.lab?.key === key);
    const fields = {};
    for (const x of list) fields[x.field] = (fields[x.field] || 0) + 1;
    return { key, label, n: list.length, n90: list.filter(in90).length, discoveries: list.filter((x) => x.kind === 'discovery').length, fields };
  }).filter((l) => l.n).sort((a, b) => b.n - a.n);
  const r90 = out.filter(in90);
  return {
    generatedAt: now,
    days,
    headlines,
    events: out.slice(0, 500),
    months,
    groups: GROUPS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.group === key).length, n90: r90.filter((x) => x.group === key).length, prev90: out.filter((x) => x.group === key && prev90(x)).length })),
    fields: Object.entries(FIELD_LABEL).map(([key, label]) => ({ key, label, n: out.filter((x) => x.field === key).length })),
    kinds: KINDS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.kind === key).length, n90: r90.filter((x) => x.kind === key).length })),
    labs,
    discoveries: out.filter((x) => x.kind === 'discovery' && (x.outlets >= 2 || x.lab)).slice(0, 14).map(({ reports, ...x }) => x),
    labels: { fields: FIELD_LABEL, groups: GROUP_LABEL, kinds: KIND_LABEL },
    stats: {
      events: out.length,
      n90: r90.length,
      prev90: out.filter(prev90).length,
      discoveries90: r90.filter((x) => x.kind === 'discovery').length,
      concerns90: r90.filter((x) => x.kind === 'concern').length,
      health90: r90.filter((x) => x.group === 'health').length,
      topLab: labs[0] ? { label: labs[0].label, n: labs[0].n } : null,
    },
  };
}

export const scienceQuery = () => cachedJob('science', { kind: 'science' }, TTL_MS);
