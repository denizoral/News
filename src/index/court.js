// Courtroom: the lawsuits, rulings and settlements around AI companies, read
// from a year of headlines. A legal headline names a defendant (an AI lab or
// big tech company), often a plaintiff ("Apple sues OpenAI", "lawsuit against
// Meta", authors, newspapers, a state attorney general), and what happened:
// filed, a ruling, dismissed, settled or a verdict. Headlines about the same
// defendant and the same plaintiff (or, without one, the same kind of claim)
// are one case; the case's latest decisive event is its status.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { vocabNodes } from './graph.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const COURT_DAYS = 365;

const FTS = 'title:(sue* OR suing OR lawsuit* OR judge* OR court* OR settle* OR ruling* OR verdict* OR jury OR injunction* OR dismiss* OR appeal* OR "class action" OR "attorney general" OR "attorneys general" OR plaintiff* OR trial OR infring* OR "trade secret" OR "trade secrets")';

export const LEGAL = /\b(?:sues?|sued|suing|lawsuits?|class[- ]action|judges?|court|courts|courtroom|settles?|settled|settlement|rulings?|(?:judge|court|justices?) rule[sd]?|jury|injunction|dismiss(?:es|ed)? (?:the |a |an |his |her |its |their )?(?:case|suit|lawsuit|claims?|charges|complaint|antitrust)|dismissal|(?:judge|court) dismiss\w*|appeals court|on trial|(?:copyright|jury|criminal) trial|trial (?:begins|starts|opens|date|judge)|plaintiffs?|attorneys? general|infring\w*|trade secrets?)\b/i;
// Figures of speech and other senses of the same words.
const NOT_LEGAL = /\bsettle(?:s|d)? (?:for|on|into|in|down|the debate|the question)\b|\bin (?:\S+['’]s|the|their|its) court\b|\bcourt(?:s|ing|ed)? (?:customers|developers|investors|users|talent|buyers|enterprises|creators|partners|advertisers|startups|favou?r|controversy)\b|\bfood court\b|\btrial (?:run|version|period|users|of|for (?:free|users))\b|\bfree trial\b|\bclinical trials?\b|\brules (?:out|for|of|on)\b|\bjudges? (?:say|said|panel of ai|for)\b(?!.*\b(?:lawsuit|case|court)\b)|\bhackathon\b|\bcompetition\b|\bbill\b|\bcourting\b|\bto court\b|\b(?:ai|llm|safety|model) judges?\b|\bjudges? (?:models?|llms?)\b|\b(?:will|could|may|would|might) be sued\b|\bverdict on\b|\bcoming \w+ verdict\b/i;
// Big tech and chip makers are in plenty of cases that have nothing to do
// with AI: their headlines need an AI word.
const AI_NATIVE = new Set(['openai', 'anthropic', 'xai', 'character-ai', 'midjourney', 'stability-ai', 'perplexity', 'suno', 'udio', 'runway', 'deepseek', 'mistral', 'cohere', 'scale-ai', 'cursor', 'hugging-face', 'elevenlabs', 'clearview-ai']);
const AI_WORD = /\bAI\b|artificial intelligence|chatbots?|\bmodels?\b|\bGemini\b|\bCopilot\b|\bLlama\b|\bSiri\b|\bAlexa\b|\bGrok\b|ChatGPT|\bClaude\b|\btraining\b|data cent(?:er|re)s?|algorithm|\bAI-|\bGPUs?\b|\bchips?\b|\bOverviews?\b|\bdeepfakes?\b|\bagents?\b/i;

export const THEMES = [
  ['copyright', 'Copyright', /\bcopyright|\bauthors?\b|\bbooks?\b|\bpirat|\btorrent|\bfair use\b|\bmusic\b|\bsongs?\b|\blyrics\b|\bartists?\b|\bnewspapers?\b|\bpublishers?\b|\bjournalis|\binfring|\btraining data\b|\bscrap(?:e|ed|ing)\b/i],
  ['safety', 'Child safety and harm', /\bchild|\bkids?\b|\bminors?\b|\bteens?\b|\bsuicide|\bself-harm|\bharm(?:s|ed|ful)?\b|\bwrongful death\b|\bmental health\b|\bstarve\b|\bdelusion/i],
  ['images', 'Deepfakes and abuse images', /\bdeepfakes?\b|\bnud(?:e|es|ify)\b|\bsexual|\bcsam\b|\bsex images?\b|\bexplicit\b/i],
  ['privacy', 'Privacy and data', /\bprivacy\b|\bpersonal data\b|\buser data\b|\bbiometric|\bconsent\b|\bwiretap|\bsurveil|\brecord(?:ing|ed)? (?:conversations|users)|\bdata of\b|\bchildren['’]s (?:user )?data\b/i],
  ['secrets', 'Trade secrets and poaching', /\btrade secrets?\b|\bstole|\bstealing\b|\bconfidential\b|\bpoach|\bex-employees?\b|\bnon-?compete\b/i],
  ['antitrust', 'Antitrust and competition', /\bantitrust\b|\bmonopol|\banti-?competitive\b|\bcompetition (?:law|regulator|case)\b|\bftc\b|\bdoj\b/i],
  ['defamation', 'Defamation and AI answers', /\bdefam|\blibel|\bslander|\bliable for what\b|\bfalse(?:ly)? (?:claims?|accus)|\bhallucinat|\boverviews?\b|\bpinned\b/i],
  ['government', 'Government and national security', /\bpentagon\b|\bblacklist|\bsupply[- ]chain risk\b|\bnational security\b|\bdepartment of (?:defense|war)\b|\bexport\b|\bexecutive order\b|\bstate (?:law|ban)\b|\bban on\b|\bpreempt/i],
  ['governance', 'Governance and control', /\bnonprofit\b|\bnon-profit\b|\bfor-profit\b|\brestructur|\bmission\b|\bcharter\b|\bboard\b|\bmusk\b.*\bopenai\b|\bopenai\b.*\bmusk\b/i],
  ['criminal', 'Criminal cases', /\barrest|\bcharged\b|\bindict|\bbail\b|\bdetain|\bbond\b|\baccused of (?:bugging|spying|planting)|\bprosecut|\bguilty\b|\bsentenc|\bheld in\b|\bbugging\b|\bspy(?:ing)?\b|\bplant(?:ed|ing) (?:a )?device\b/i],
  ['labor', 'Workers and discrimination', /\bdiscriminat|\bworkers?\b|\bemployees? (?:sue|lawsuit)|\bh-?1b\b|\blabor\b|\bunion\b|\bwrongful(?:ly)? (?:terminat|fir)/i],
  ['other', 'Other', /./],
];
const THEME_LABEL = Object.fromEntries(THEMES.map(([k, l]) => [k, l]));

// Who gets sued, most likely first: in "Judge orders OpenAI to ... in Apple
// trade secrets case", OpenAI is the defendant.
const DEFENDANTS = ['openai', 'anthropic', 'xai', 'meta', 'google', 'google-deepmind', 'microsoft', 'character-ai', 'midjourney', 'stability-ai', 'perplexity', 'nvidia', 'suno', 'udio', 'runway', 'deepseek', 'mistral', 'cohere', 'amazon', 'apple', 'tesla', 'bytedance', 'tiktok', 'github', 'scale-ai', 'cursor', 'hugging-face', 'elevenlabs', 'clearview-ai'];

// Plaintiffs that aren't in the entity vocabulary.
const PLAINTIFFS = [
  ['new-york-times', 'The New York Times', /\b(?:new york times|nyt)\b/i],
  ['news-publishers', 'News publishers', /\b(?:newspapers?|news (?:publishers|outlets|organi[sz]ations)|publishers|daily news|tribune|seattle times|newsday|dow jones|ziff davis|britannica|reuters|the intercept|raw story|chicago tribune|news corp)\b/i],
  ['authors', 'Authors', /\b(?:authors?|writers?|novelists?|authors guild)\b/i],
  ['music', 'Music labels and publishers', /\b(?:music publishers?|record labels?|labels|umg|universal music|sony music|warner music|sony|warner|concord|riaa|musicians?)\b/i],
  ['artists', 'Artists', /\b(?:artists?|illustrators?|getty images|getty|disney|universal|photographers?)\b/i],
  ['states', 'US states', /\b(?:attorneys? general|AG|states|state of [A-Z]\w+|(?:florida|texas|california|kentucky|new york|utah|minnesota|ohio|illinois|new mexico|pennsylvania|michigan|washington|massachusetts|new jersey|arizona|colorado|virginia|louisiana|georgia|tennessee|missouri|indiana|oregon)(?:['’]s)? (?:ag|attorney|sues|lawsuit|governor|officials|regulators|law))\b/i],
  ['families', 'Parents and families', /\b(?:parents?|famil(?:y|ies)|mother|father|widow|teen['’]s)\b/i],
  ['us-gov', 'US government', /\b(?:pentagon|justice department|doj|ftc|department of (?:defense|war|justice)|civil rights division|sec\b|federal government|trump administration|white house)\b/i],
  ['users', 'Users (class action)', /\b(?:users|consumers|customers|class[- ]action)\b/i],
];

const MONEY = /\$\s?(\d+(?:\.\d+)?)\s?(billion|bn|b|million|mn|m)\b/i;
export function amountOf(title) {
  const m = MONEY.exec(title);
  if (!m) return null;
  return +m[1] * (/^b/i.test(m[2]) ? 1e9 : 1e6);
}

export function kindOf(title) {
  if (/\bsettle(?:s|d|ment|ments)?\b/i.test(title) && !/\bsettle(?:s|d)? for\b|(?:\bnot|n['’]t|\brefuses? to|\bno plans? to)\s+(?:\w+\s+){0,2}settle\b/i.test(title)) return 'settled';
  if (/\bverdict\b|\bjury (?:finds|found|awards|orders|says|rules)|\bfound liable\b/i.test(title)) return 'verdict';
  if (/\bdismiss(?:es|ed)? (?:the |a |an |his |her |its |their )?(?:case|suit|lawsuit|claims?|charges|complaint|antitrust)|\bdismissal\b|\b(?:judge|court) dismiss\w*|\bthrows out\b|\btossed\b|\btosses\b/i.test(title)) return 'dismissed';
  if (/\b(?:judges?|court|courts|appeals|justices?)\b.*\b(?:rules?|ruled|orders?|ordered|denies|denied|grants?|granted|blocks?|blocked|halts?|allows?|lets|rejects?|rejected|says|sides|approves?|approved|backs|upholds?|pauses?|puts?|bars?|refuses?|makes?|hold|holds)\b|\bruling\b|\binjunction\b|\bblocked by\b|\bon hold\b/i.test(title)) return 'ruling';
  if (/\bsues?\b|\bsued\b|\bsuing\b|\blawsuits?\b|\bfiles? (?:a )?(?:suit|complaint|lawsuit)\b|\bclass[- ]action\b|\bcomplaint\b|\bhit with\b/i.test(title)) return 'filed';
  return 'hearing';
}

export const KIND_RANK = { filed: 1, hearing: 0, ruling: 2, dismissed: 3, verdict: 4, settled: 4 };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeCourtParser(nodes = vocabNodes()) {
  const orgs = nodes.filter((n) => n.type === 'org' || n.type === 'person');
  const aliases = orgs.flatMap((o) => o.aliases.map((a) => [a, o])).sort((a, b) => b[0].length - a[0].length);
  const byAlias = new Map(aliases.map(([a, o]) => [a.toLowerCase(), o]));
  // One pass of small regexes per first word, as in talent.js: a single
  // alternation over every alias backtracks badly on long titles.
  const byFirst = new Map();
  for (const [a, o] of aliases) {
    const f = a.split(/[^\w.-]/)[0].toLowerCase();
    (byFirst.get(f) || byFirst.set(f, []).get(f)).push([a, o]);
  }
  const mentions = (title) => {
    const out = [];
    const re = /[\w.-]+/g;
    let m;
    while ((m = re.exec(title))) {
      for (const [a, o] of byFirst.get(m[0].toLowerCase().replace(/['’]s$/, '')) || []) {
        const s = title.slice(m.index, m.index + a.length);
        if (s.toLowerCase() === a.toLowerCase() && !/[\w]/.test(title[m.index + a.length] || '')) { out.push({ node: o, at: m.index }); break; }
      }
    }
    return out;
  };
  const rank = (n) => { const i = DEFENDANTS.indexOf(n.key); return i < 0 ? 99 : i; };
  const SUES = /^(?<p>.+?)\s+(?:sues|is suing|are suing|to sue|files? (?:a )?(?:lawsuit|suit|complaint) against|takes)\s+(?<d>.+)$/i;
  const SUED_BY = /^(?<d>.+?)\s+(?:(?:(?:gets?|was|is|been|being)\s+)?sued\b(?:\s+by\s+(?<p>.+))?|faces (?:a )?(?:lawsuit|suit|class action) (?:from|by)\s+(?<p2>.+)|hit with (?:a )?(?:lawsuit|suit) (?:from|by)\s+(?<p3>.+))/i;
  const AGAINST = /\b(?:lawsuit|suit|case|complaint|claims?) against\s+(?<d>.+)$/i;
  const firstOrg = (s) => mentions(s)[0]?.node || null;
  const lastOrg = (s) => mentions(s).at(-1)?.node || null;
  // Without "X sues Y", another name is a party only when the headline puts
  // it next to the case ("Apple trade secrets case", "v. OpenAI", "Amazon
  // wins court order"), not when it owns or runs the defendant ("Elon Musk's
  // xAI", "OpenAI CEO Sam Altman").
  const ROLE_BEFORE = /\b(?:ceo|chief|founder|co-?founder|president|chair(?:man)?|boss|head|owner|executive|exec)\s+$/i;
  const partyAt = (title, f) => {
    const a = f.node.aliases.find((x) => title.slice(f.at, f.at + x.length).toLowerCase() === x.toLowerCase()) || f.node.label;
    const after = title.slice(f.at + a.length), before = title.slice(0, f.at);
    if (/^['’]s?\s+(?!(?:lawsuit|suit|case|complaint|claims?|legal)\b)/.test(after) || ROLE_BEFORE.test(before)) return false;
    return /^(?:['’]s?)?\s+(?:[\w-]+\s+){0,3}?(?:case|lawsuit|suit|trial|complaint|v\.?|vs\.?)\b|^\s+(?:wins?|won|loses?|lost|sues|sued|is suing|takes)\b/i.test(after) || /\b(?:v\.?|vs\.?|against|by)\s+$/i.test(before);
  };

  return function parse(title) {
    if (!LEGAL.test(title) || NOT_LEGAL.test(title)) return null;
    const found = mentions(title);
    if (!found.length) return null;
    let defendant = null, plaintiff = null;
    let m;
    if ((m = SUED_BY.exec(title))) {
      defendant = lastOrg(m.groups.d);
      const p = m.groups.p || m.groups.p2 || m.groups.p3;
      plaintiff = p ? firstOrg(p) : null;
    } else if ((m = SUES.exec(title))) {
      defendant = firstOrg(m.groups.d);
      // "Elon Musk's xAI sues ...": the company nearest the verb.
      plaintiff = lastOrg(m.groups.p);
      if (defendant && plaintiff && defendant.key === plaintiff.key) plaintiff = null;
    } else if ((m = AGAINST.exec(title))) defendant = firstOrg(m.groups.d);
    if (!defendant) {
      const cands = found.map((f) => f.node).filter((n) => n.type === 'org' && rank(n) < 99).sort((a, b) => rank(a) - rank(b));
      defendant = cands[0] || null;
    }
    if (!defendant || defendant.type !== 'org') return null;
    if (!AI_NATIVE.has(defendant.key) && !AI_WORD.test(title)) return null;
    if (!plaintiff) plaintiff = found.find((f) => f.node.key !== defendant.key && partyAt(title, f))?.node ?? null;
    if (plaintiff && plaintiff.key === defendant.key) plaintiff = null;
    // "Google" and "Google DeepMind" are the same defendant.
    let pl = plaintiff ? { key: plaintiff.key, label: plaintiff.key === 'new-york-times' ? 'The New York Times' : plaintiff.label } : null;
    if (!pl) {
      const p = PLAINTIFFS.find(([, , re]) => re.test(title));
      if (p) pl = { key: p[0], label: p[1] };
    }
    const theme = THEMES.find(([, , re]) => re.test(title))[0];
    return { defendant: { key: defendant.key === 'google-deepmind' ? 'google' : defendant.key, label: defendant.key === 'google-deepmind' ? 'Google' : defendant.label }, plaintiff: pl, theme, kind: kindOf(title), amount: amountOf(title) };
  };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeCourt(db, now = Date.now(), days = COURT_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);
  const parse = makeCourtParser();
  const cases = new Map();
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue; // English headlines
    const p = parse(title);
    if (!p) continue;
    headlines++;
    // Same defendant and plaintiff is one case; without a plaintiff, the
    // same defendant and kind of claim.
    const id = `${p.defendant.key}--${p.plaintiff ? p.plaintiff.key : p.theme}`;
    let c = cases.get(id);
    if (!c) {
      c = { id, defendant: p.defendant, plaintiff: p.plaintiff, themes: new Map(), events: [], amount: null };
      cases.set(id, c);
    }
    c.themes.set(p.theme, (c.themes.get(p.theme) || 0) + 1);
    if (p.amount && ['settled', 'verdict'].includes(p.kind)) c.amount = Math.max(c.amount || 0, p.amount);
    // The same news from several outlets within two days is one event.
    const toks = new Set(tokens(title));
    const same = c.events.find((e) => e.kind === p.kind && r.at - e.last < 2 * DAY && overlap(toks, e.toks) >= 0.5);
    const source = outlet || r.source || r.site;
    if (same) {
      same.outlets.add(source);
      same.last = r.at;
      continue;
    }
    c.events.push({ at: r.at, last: r.at, kind: p.kind, title, url: r.url, source, outlets: new Set([source]), toks });
  }

  // A case seen without its plaintiff ("OpenAI agrees not to use trade
  // secrets") joins the one case of that defendant and kind that names one.
  const themeOf = (c) => [...c.themes].sort((a, b) => b[1] - a[1])[0][0];
  for (const c of [...cases.values()]) {
    if (c.plaintiff) continue;
    const t = themeOf(c);
    if (t === 'other') continue;
    const into = [...cases.values()].filter((x) => x.plaintiff && x.defendant.key === c.defendant.key && themeOf(x) === t);
    if (into.length !== 1) continue;
    const x = into[0];
    x.events = [...x.events, ...c.events].sort((a, b) => a.at - b.at);
    for (const [k, n] of c.themes) x.themes.set(k, (x.themes.get(k) || 0) + n);
    x.amount = Math.max(x.amount || 0, c.amount || 0) || null;
    cases.delete(c.id);
  }

  const out = [];
  for (const c of cases.values()) {
    const outlets = new Set(c.events.flatMap((e) => [...e.outlets]));
    // A single headline from one outlet with no clear action is noise.
    if (c.events.length === 1 && outlets.size === 1 && c.events[0].kind === 'hearing') continue;
    const theme = [...c.themes].filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
    const decisive = [...c.events].reverse().find((e) => e.kind !== 'hearing') || c.events[c.events.length - 1];
    const status = decisive.kind === 'hearing' ? 'ongoing' : decisive.kind === 'filed' ? 'filed' : decisive.kind;
    out.push({
      id: c.id,
      title: c.plaintiff ? `${c.plaintiff.label} v. ${c.defendant.label}` : `${c.defendant.label}: ${theme === 'other' ? 'other cases' : THEME_LABEL[theme].toLowerCase()}`,
      defendant: c.defendant,
      plaintiff: c.plaintiff,
      theme,
      status,
      amount: c.amount,
      first: c.events[0].at,
      last: c.events[c.events.length - 1].last,
      outlets: outlets.size,
      headlines: c.events.reduce((s, e) => s + e.outlets.size, 0),
      events: c.events.slice(-25).map((e) => ({ at: e.at, kind: e.kind, title: e.title, url: e.url, source: e.source, outlets: e.outlets.size })),
    });
  }
  // Weight: coverage, with recent activity first among equals.
  out.sort((a, b) => b.last - a.last);

  // Twelve months of filings, rulings and outcomes (each event once).
  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), filed: 0, rulings: 0, outcomes: 0 });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const c of out) for (const e of c.events) {
    const m = months[mi.get(new Date(e.at).toISOString().slice(0, 7))];
    if (!m) continue;
    if (e.kind === 'filed') m.filed++;
    else if (e.kind === 'ruling') m.rulings++;
    else if (e.kind !== 'hearing') m.outcomes++;
  }

  // Defendants by kind of claim.
  const defs = new Map();
  for (const c of out) {
    const d = defs.get(c.defendant.key) || { key: c.defendant.key, label: c.defendant.label, n: 0, active: 0, themes: {} };
    d.n++;
    if (['filed', 'ongoing', 'ruling'].includes(c.status)) d.active++;
    d.themes[c.theme] = (d.themes[c.theme] || 0) + 1;
    defs.set(d.key, d);
  }
  const themes = THEMES.map(([key, label]) => ({ key, label, n: out.filter((c) => c.theme === key).length })).filter((t) => t.n);

  return {
    generatedAt: now,
    days,
    headlines,
    cases: out.slice(0, 300),
    months,
    defendants: [...defs.values()].sort((a, b) => b.n - a.n).slice(0, 12),
    themes,
    stats: {
      cases: out.length,
      filed30: out.reduce((s, c) => s + c.events.filter((e) => e.kind === 'filed' && e.at >= now - 30 * DAY).length, 0),
      settled: out.filter((c) => c.status === 'settled').length,
      biggest: out.filter((c) => c.amount).sort((a, b) => b.amount - a.amount)[0] || null,
    },
  };
}

export const courtQuery = () => cachedJob('court', { kind: 'court' }, TTL_MS);
