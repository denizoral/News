// New names: models, products, projects and companies that weren't in the
// news before and now are ("Claude Duet", "GPT-6.1 Sol", "TorchTPU").
//
// A name is a run of capitalised or numbered words ("MiniMax M3.1 Flash")
// that stays capitalised mid-sentence in descriptions (so a Title Case
// headline's "Bans DeepSeek" doesn't count), is carried by several outlets,
// and has no more than a stray mention before its first sustained day. A
// shorter name inside a longer one that nearly always comes with it folds into
// the longer ("Duet" into "Claude Duet").
//
// For each: what it is, in the articles' own words (the appositive or "is a"
// clause most outlets agree on, from article bodies), who is behind it (the
// lab or company it's most often named with), when it first appeared and
// where, and how fast it's spreading (daily mentions).

import { scanWindow, nameMatcher } from './graph.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const NEW_DAYS = 60; // "new" means first seen in the last 60 days

const STOPWORD = new Set(('a an the of to in on for and or but with by at from as is are was were be been it its this that these those will can could would should may might has have had do does did not ' +
  'no new how why what who when where which than then there their they them we our you your he she his her i me my us after over into out up about more most just now also all any some ' +
  'one two three first last says said say via per amid vs here exclusive breaking update report watch live video podcast opinion analysis review').split(' '));
const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$|^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
// Words that dress a name up but aren't part of it ("Duet AI", "AI Startups").
const GENERIC = new Set('ai agi agent agents startup startups chinese american us uk eu personal model models chip chips tech app apps new open company lab labs ceo report the'.split(' '));
const WORD = /[\p{L}\p{N}][\p{L}\p{N}.+\-]*[\p{L}\p{N}+]|[\p{L}\p{N}]/gu;

// A token that can be part of a name: Capitalised, ALLCAPS, camelCase or
// carrying a digit ("M3.1", "5.5"), and not a stop word or a month.
const nameish = (t) => /^[\p{Lu}\p{N}]|^\p{Ll}+\p{Lu}/u.test(t) && !STOPWORD.has(t.toLowerCase()) && !MONTH.test(t) && !/^\d+(?:[.,]\d+)?$/.test(t) && !/^\d+(?:st|nd|rd|th|s|m|b|k|x|gb|tb|%)$/i.test(t);

// Every run of 1-4 name-like tokens in a text, keyed in lower case.
export function nameRuns(text) {
  const out = new Map();
  for (const part of text.split(/[,;:!?()"“”‘’'|—–]+|\.\s/)) {
    const toks = part.match(WORD) || [];
    for (let i = 0; i < toks.length; i++) {
      if (!nameish(toks[i])) continue;
      if (GENERIC.has(toks[i].toLowerCase())) continue;
      for (let k = 1; k <= 4 && i + k <= toks.length; k++) {
        if (!nameish(toks[i + k - 1])) break;
        const g = toks.slice(i, i + k);
        if (GENERIC.has(g[k - 1].toLowerCase())) continue;
        // At least one word that isn't a plain capitalised dictionary-looking
        // word on its own: one-word names need a digit, inner caps or caps.
        if (k === 1 && !/\d|^[A-Z]{2,}|[a-z][A-Z]/.test(g[0]) && g[0].length < 5) continue;
        const form = g.join(' ');
        const key = form.toLowerCase();
        if (key.length < 3) continue;
        if (!out.has(key)) out.set(key, form);
      }
    }
  }
  return out;
}

// What it is: "Claude Duet, a proactive AI agent that ...", "TorchTPU is an
// open-source ...", "a new chip called Argon".
export function definitionsIn(body, form) {
  const esc = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const out = [];
  const after = new RegExp(`(?<![\\w-])${esc}(?:['’]s)?\\s*(?:,|\\(|—|–|\\s-\\s)\\s*((?:a|an|the|its|their|which is|which are|is|are)\\s[^.;:()—–]{8,180}?)(?=[,.;)—–]|\\s-\\s)`, 'g');
  const is = new RegExp(`(?<![\\w-])${esc}\\s+(?:is|are|was)\\s+((?:a|an|the)\\s[^.;:()]{8,180}?)(?=[.;,]|$)`, 'g');
  const called = new RegExp(`\\b((?:a|an|the|its|their)\\s(?:[\\w\\-]+\\s){0,6}?[\\w\\-]+)\\s(?:called|named|dubbed|known as|branded)\\s["“]?${esc}(?![\\w-])`, 'gi');
  for (const m of body.matchAll(after)) out.push(m[1]);
  for (const m of body.matchAll(is)) out.push(m[1]);
  for (const m of body.matchAll(called)) out.push(m[1]);
  return out
    // Scraped bodies glue blocks together ("a Proactive AI AgentWednesday").
    .map((s) => s.split(/(?<=[a-z])(?=(?:Published|Updated|Posted|Read|Share|Home|By|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|June|July|August|September|October|November|December)\b)/)[0])
    .map((s) => s.replace(/^which (?:is|are)\s+|^(?:is|are)\s+/i, '').replace(/\s+/g, ' ').trim())
    // "a/an ..." is a definition; "the/its ..." only when it names what kind
    // of thing it is early on ("the inference framework that ...").
    .filter((s) => /^(?:an?)\s/i.test(s) || (/^(?:the|its|their)\s/i.test(s) && HEADS.test(s.split(' ').slice(0, 6).join(' ')) && !/^(?:the|its|their) \w+ (?:is|are|was|has|have|will|would|can|\w+s)\b/i.test(s)))
    .filter((s) => s.split(' ').length >= 3 && !/\b(?:said|says|told|according)\b/i.test(s));
}

const HEADS = /\b(model|models|agent|agents|assistant|chip|chips|accelerator|gpu|processor|framework|library|tool|tools|app|application|platform|service|feature|startup|company|lab|benchmark|dataset|device|glasses|robot|robots|humanoid|headset|phone|laptop|system|engine|api|sdk|language|protocol|fund|program|programme|initiative|project|cluster|supercomputer|data cent(?:er|re)|campus|browser|bot|chatbot|plan|tier|subscription|exploit|vulnerability|flaw|malware|bill|law|act|rule)s?\b/i;
const KINDS = [
  ['model', /\b(?:model|llm|weights|checkpoint|reasoning)\b/i],
  ['agent', /\b(?:agent|assistant|chatbot|bot)\b/i],
  ['chip', /\b(?:chip|accelerator|gpu|processor|silicon|tpu|npu)\b/i],
  ['device', /\b(?:device|glasses|headset|phone|laptop|robot|humanoid|speaker|camera|wearable|console)\b/i],
  ['company', /\b(?:startup|company|lab|firm|maker|developer|unicorn)\b/i],
  ['security', /\b(?:exploit|vulnerability|flaw|malware|attack|backdoor)\b/i],
  ['policy', /\b(?:bill|law|act|rule|regulation|order|framework for)\b/i],
  ['tool', /\b(?:tool|framework|library|sdk|api|platform|service|app|feature|browser|engine|protocol)\b/i],
  ['project', /\b(?:project|program|programme|initiative|fund|campus|cluster|data cent(?:er|re)|supercomputer)\b/i],
];
const PERSON = /\b(?:engineer|researcher|scientist|executive|ceo|cto|founder|co-founder|employee|worker|professor|investor|analyst|official|minister|senator|director|head of|former|chief)\b/i;

// The definition most outlets agree on: group by head noun, prefer the
// commonest head, then a clause of a readable length from the earliest source.
export function bestDefinition(cands) {
  if (!cands.length) return null;
  const heads = new Map();
  for (const c of cands) {
    const h = (c.text.match(HEADS)?.[1] || '').toLowerCase().replace(/s$/, '');
    const e = heads.get(h) || { n: 0, sources: new Set(), items: [] };
    e.n++;
    e.sources.add(c.source);
    e.items.push(c);
    heads.set(h, e);
  }
  const [, top] = [...heads].sort((a, b) => (b[0] !== '') - (a[0] !== '') || b[1].sources.size - a[1].sources.size || b[1].n - a[1].n)[0];
  const fit = (c) => Math.abs(c.text.length - 90) + (c.text.length > 160 ? 60 : 0);
  const pick = [...top.items].sort((a, b) => fit(a) - fit(b) || a.at - b.at)[0];
  return { text: pick.text, source: pick.source, url: pick.url, agree: top.sources.size };
}

export function kindOf(definition, form) {
  if (!definition) return /\d/.test(form) ? 'model' : 'other';
  if (PERSON.test(definition.split(' ').slice(0, 6).join(' '))) return 'person';
  for (const [k, re] of KINDS) if (re.test(definition)) return k;
  return 'other';
}

export function computeNewNames(db, { now = Date.now(), days = NEW_DAYS, limit = 48, bodies = true } = {}) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT title, substr(description, 1, 400) AS description, source, site, url, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND title != '' AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')
      AND site NOT IN ('huggingface.co', 'openrouter.ai', 'github.com', 'arxiv.org')`).all(since, now + 5 * 60e3);
  const recentDocs = rows.length;
  const terms = new Map();
  for (const r of rows) {
    for (const [key, form] of nameRuns(`${r.title}. ${r.description || ''}`)) {
      let e = terms.get(key);
      if (!e) terms.set(key, (e = { key, forms: new Map(), recent: [], sources: new Set() }));
      e.recent.push(r);
      e.sources.add(r.source || r.site);
      e.forms.set(form, (e.forms.get(form) || 0) + 1);
    }
  }

  // Candidates: carried by several outlets.
  const minDocs = Math.max(6, Math.round(recentDocs / 4000));
  let cands = [...terms.values()].filter((e) => e.recent.length >= minDocs && e.sources.size >= 4);

  // The entity graph's own vocabulary isn't new (names it discovered lately
  // can be), nor are outlets, nor "OpenAI Dots" when it's "Dots" with its owner.
  const scan = scanWindow(db, 90, now);
  const known = new Set(scan.nodes.filter((n) => n.type !== 'other').flatMap((n) => [n.label, ...n.aliases]).map((s) => s.toLowerCase()));
  const outlets = new Set(rows.map((r) => (r.source || '').toLowerCase()));
  cands = cands.filter((e) => !known.has(e.key) && !outlets.has(e.key) && !e.key.split(' ').every((w) => known.has(w) || GENERIC.has(w)));

  // Must stay capitalised mid-sentence in descriptions: count lower-case
  // uses of the same words there.
  for (const e of cands) {
    const re = new RegExp(`(?<![\\w-])${e.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi');
    let lower = 0, upper = 0;
    for (const r of e.recent) {
      for (const m of (r.description || '').matchAll(re)) (m[0] === m[0].toLowerCase() && /[a-z]/.test(m[0]) ? lower++ : upper++);
    }
    e.capShare = upper / Math.max(1, upper + lower);
    e.descUses = upper + lower;
  }
  cands = cands.filter((e) => e.descUses === 0 ? /\d|[a-z][A-Z]|^[A-Z]{2,}/.test([...e.forms.keys()][0]) : e.capShare >= 0.8);

  // Nested names: the longer wins when it carries most of the shorter's uses.
  cands.sort((a, b) => b.key.length - a.key.length);
  const drop = new Set();
  for (const s of cands) {
    for (const l of cands) {
      if (l === s || drop.has(l) || !(` ${l.key} `).includes(` ${s.key} `)) continue;
      if (l.recent.length >= 0.6 * s.recent.length) drop.add(s);
      else drop.add(l);
    }
  }
  cands = cands.filter((e) => !drop.has(e));

  // New means barely there before the window, anywhere in the archive. Only
  // headlines and descriptions count: evergreen pages ("74 best AI tools")
  // get rewritten with new names but keep their old dates.
  const ftsPhrase = (key) => `"${key.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}"`;
  // Counting stops at 60: enough to say "not new" (1 ms a name, against 18 ms
  // for an IN subquery that counts every match).
  const before = db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM docs_fts f JOIN docs d ON d.id = f.rowid WHERE docs_fts MATCH ? AND d.published_at < ? AND d.hidden = 0 LIMIT 60)`);
  cands = cands.filter((e) => {
    try {
      e.before = before.get(`{title description} : ${ftsPhrase(e.key)}`, since - 3 * DAY).n;
    } catch { e.before = 0; }
    return e.before <= Math.max(2, e.recent.length / 25);
  });

  const firstOf = (e) => e.recent.reduce((a, r) => (r.at < a.at ? r : a), e.recent[0]);
  cands.sort((a, b) => b.sources.size * Math.log2(1 + b.recent.length) - a.sources.size * Math.log2(1 + a.recent.length));
  cands = cands.slice(0, limit);

  const namesIn = nameMatcher(scan.nodes);
  // The FTS match goes in a subquery: joined, SQLite walks docs by date and
  // probes the index per row (10 s for a common phrase, against 6 ms).
  const ftsHits = db.prepare(`SELECT url, title, source, site, published_at AS at, substr(body, 1, 12000) AS body FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? LIMIT 400) AND hidden = 0 AND type = 'article' AND published_at >= ? ORDER BY published_at LIMIT 30`);
  const names = cands.map((e) => {
    const form = [...e.forms].sort((a, b) => b[1] - a[1])[0][0];
    const first = firstOf(e);
    // Who it belongs to: the known name it's most often mentioned with.
    const by = new Map();
    const self = (i) => {
      const l = scan.nodes[i].label.toLowerCase();
      return l.includes(e.key) || e.key.includes(l);
    };
    for (const r of e.recent) for (const i of namesIn(`${r.title}. ${r.description || ''}`)) if (!self(i)) by.set(i, (by.get(i) || 0) + 1);
    // "OpenAI Dots" is OpenAI's.
    const named = scan.nodes.findIndex((n) => n.type === 'org' && e.key.startsWith(`${n.label.toLowerCase()} `));
    const owner = named >= 0 ? [named, Infinity] : [...by].sort((a, b) => b[1] - a[1])[0];
    // What it is.
    let definition = null;
    if (bodies) {
      const cs = [];
      try {
        for (const d of ftsHits.all(ftsPhrase(e.key), since - 7 * DAY)) for (const text of definitionsIn(`${d.title}. ${d.body || ''}`, form)) cs.push({ text, source: d.source || d.site, url: d.url, at: d.at });
      } catch { /* a phrase FTS can't parse */ }
      for (const r of e.recent) for (const text of definitionsIn(r.description || '', form)) cs.push({ text, source: r.source || r.site, url: r.url, at: r.at });
      definition = bestDefinition(cs);
    }
    const series = new Array(days).fill(0);
    for (const r of e.recent) series[Math.min(days - 1, Math.max(0, Math.floor((r.at - since) / DAY)))]++;
    const last7 = series.slice(-7).reduce((s, v) => s + v, 0);
    const prev7 = series.slice(-14, -7).reduce((s, v) => s + v, 0);
    const seenDays = series.filter(Boolean).length;
    const head = [...new Map(e.recent.sort((a, b) => b.at - a.at).map((r) => [r.title.toLowerCase().slice(0, 60), r])).values()].slice(0, 5);
    return {
      key: e.key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: form,
      kind: kindOf(definition?.text, form),
      definition,
      owner: owner && owner[1] >= Math.max(2, e.recent.length / 5) ? { key: scan.nodes[owner[0]].key, label: scan.nodes[owner[0]].label } : null,
      mentions: e.recent.length,
      before: e.before,
      outlets: e.sources.size,
      first: { at: first.at, title: first.title, url: first.url, source: first.source || first.site },
      last: e.recent.reduce((a, r) => Math.max(a, r.at), 0),
      days: seenDays,
      trend: last7 > prev7 * 1.3 && last7 >= 3 ? 'rising' : last7 * 1.3 < prev7 ? 'fading' : 'steady',
      week: last7,
      series,
      headlines: head.map((r) => ({ title: r.title, url: r.url, source: r.source || r.site, at: r.at })),
    };
  });
  // People named in the news are a different list; keep products and
  // projects we can say something about.
  const list = names.filter((n) => n.kind !== 'person' && (n.definition?.agree >= 2 || (n.definition && /\d|\p{Ll}\p{Lu}|^\p{Lu}{2,}/u.test(n.name)) || (n.owner && n.kind !== 'other')));
  return {
    days,
    since,
    generatedAt: now,
    docs: recentDocs,
    kinds: [...new Set(list.map((n) => n.kind))],
    names: list.sort((a, b) => b.first.at - a.first.at),
  };
}

export const newNamesQuery = () => cachedJob('newnames', { kind: 'newnames' }, TTL_MS);
