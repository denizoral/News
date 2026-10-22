// Who said what: direct quotes in stored articles and who they're attributed
// to. Reads article bodies for the common reporting shapes —
//   “…,” said Jane Doe, CEO of Acme.     “…,” Jane Doe said.
//   Acme CEO Jane Doe said: “…”          “…,” Doe told Reuters.
// — resolves surnames to the full name used earlier in the same piece, and
// groups the same line carried by several outlets. Pronoun attributions
// ("he said") are skipped rather than guessed.
//
// The worker keeps every extracted quote in memory and only reads articles
// newer than the last pass, so after the first scan (~45 days of bodies,
// ~2 s) a refresh costs a few hundred rows.

import { extractEntities, isAiRelated } from '../pipeline/classify.js';
import { tokens } from '../pipeline/text.js';
import { topicLabel } from './topics.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const WINDOW_DAYS = 45;
const EN = "(lang IS NULL OR lang = '' OR lang LIKE 'en%')";

const OPEN = '[“"]';
const CLOSE = '[”"]';
// A quoted span: 30-420 chars, no nested quote marks.
const Q = `${OPEN}([^“”"\\n]{30,420}?)${CLOSE}`;
// Acronyms and camel case ("OpenAI CEO") only matter in front of a name,
// where the role is stripped off again.
const NAME_WORD = "(?:Mc[A-Z][a-z]+|[A-Z][A-Za-z]*[A-Z]|[A-Z][a-z]+[A-Z][a-z]+|[A-Z][a-zà-ÿ'’]+(?:-[A-Z][a-zà-ÿ'’]+)?|[A-Z]\\.)";
const NAME = `(${NAME_WORD}(?:\\s(?:de |van |von |da |del |bin )?${NAME_WORD}){0,3})`;
const VERB = '(?:said|says|told|added|wrote|explained|noted|argued|continued|stated|posted|tweeted|warned|claimed|insisted|recalled|admitted|acknowledged)';
// Role words that can sit in front of a name ("OpenAI CEO Sam Altman said").
const TITLE_RE = /^(?:(?:[A-Z][\w.&'’-]*\s){0,3}?)?((?:co-?founder|founder|chancellor|speaker|showrunner|prime\sminister|mayor|ambassador|commissioner|attorney|general|CISO|economist|strategist|author|lawyer|chief\s\w+\s(?:officer)?|CEO|CTO|CFO|COO|CPO|president|chair(?:man|woman)?|director|head|vice\spresident|VP|senator|sen\.|rep\.|secretary|minister|professor|prof\.|dr\.|analyst|researcher|scientist|engineer|spokesperson|spokesman|spokeswoman|partner|investor|lead|manager|executive|governor|judge)\b[\w\s'’.&-]*?)\s+(?=[A-Z])/i;

const QUOTE_AFTER = new RegExp(`${Q}\\s*,?\\s*(?:${VERB}\\s+${NAME}(?:,\\s*([^,.;“”"]{3,90}))?|${NAME}\\s*(?:,\\s*([^,.;“”"]{3,90}),\\s*)?${VERB})`, 'g');
const QUOTE_BEFORE = new RegExp(`${NAME}(?:,\\s*([^,.;“”"]{3,90}),)?\\s+${VERB}(?:\\s+(?:that|in a statement|in an interview|on X|in a post|to [A-Z][\\w ]{2,30}))?\\s*[:,]\\s*${Q}`, 'g');

// Not names: sentence starters, pronouns, organisations' generic voices.
const NOT_FIRST = new Set(['the', 'a', 'an', 'he', 'she', 'they', 'it', 'we', 'i', 'you', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'its', 'our', 'my', 'one', 'some', 'many', 'others', 'company', 'officials', 'sources', 'people', 'spokesperson', 'spokesman', 'spokeswoman', 'representative', 'reuters', 'bloomberg', 'cnbc', 'techcrunch', 'axios', 'but', 'and', 'so', 'then', 'also', 'still', 'when', 'while', 'as', 'in', 'on', 'at', 'for', 'after', 'before', 'if', 'mr', 'ms', 'mrs', 'dr', 'according', 'statement', 'report', 'later', 'earlier', 'now', 'today', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'there', 'here', 'what', 'who', 'which', 'just', 'both', 'all', 'none', 'neither', 'each', 'every', 'meanwhile', 'however', 'instead', 'indeed', 'yet', 'though', 'although', 'because']);
// Organisation names that often take "said"; the person behind them is unknown.
const ORG_LIKE = /\b(?:inc|corp|ltd|llc|group|labs?|ai|company|team|government|ministry|department|agency|commission|council|court|university|institute|police|office|board|committee|association|foundation|news|times|post|journal|press|media)\b\.?$/i;

const clean = (s) => s.replace(/\s+/g, ' ').trim();

// A name as written, minus any leading role words; null when it isn't a person.
export function personName(raw) {
  let name = clean(raw || '').replace(/[-’']+$/, '');
  let role = null;
  const t = name.match(TITLE_RE);
  if (t) {
    role = clean(name.slice(0, t.index + t[0].length));
    name = name.slice(t.index + t[0].length);
  }
  let words = name.split(' ');
  // "Director of National Intelligence Jay Clayton" leaves four capitalised
  // words; the person is the last two.
  if (words.length === 4) words = words.slice(2);
  if (!words.length || words.length > 3) return null;
  if (NOT_FIRST.has(words[0].toLowerCase().replace(/[.’']/g, ''))) return null;
  name = words.join(' ');
  if (ORG_LIKE.test(name)) return null;
  if (words.some((w) => w.length > 20)) return null;
  return { name, role };
}

// A role reads like a job ("chief AI officer at Meta"), not stage directions.
const ROLE_WORD = /\b(?:CEO|CTO|CFO|COO|CPO|CISO|founder|co-?founder|chief|president|director|head|officer|analyst|professor|minister|secretary|senator|spokes\w+|partner|engineer|scientist|researcher|lead|manager|VP|vice|chair\w*|executive|attorney|lawyer|investor|economist|author|governor|commissioner|chancellor|speaker|mayor|ambassador|strategist|fellow|dean|editor|representative|leader)\b/i;
const roleOf = (s) => {
  const r = clean(s || '').replace(/^(?:and|the|a|an)\s+/i, (m) => (/^(?:and)\s/i.test(m) ? '' : m));
  if (!r || r.length > 80 || !ROLE_WORD.test(r) || /\b(?:said|says|told|who|which|when|in an interview|during|while)\b/i.test(r)) return null;
  return r;
};

const QUOTE_MARK = /[“"]/;
const SAYING = new RegExp(`\\b${VERB}\\b`);

// Every attributed quote in one article body.
export function extractQuotes(body) {
  const found = [];
  const push = (q, rawName, role, index) => {
    const p = personName(rawName);
    if (!p) return;
    const line = clean(q).replace(/^[,.\s]+|[,\s]+$/g, '');
    if (line.split(' ').length < 6) return;
    found.push({ text: line, name: p.name, role: roleOf(role) || roleOf(p.role), index });
  };
  // Only paragraphs with a quote mark and a saying verb can hold one; most
  // of a body is neither, and the patterns are costly to try everywhere.
  let offset = 0;
  const text = String(body || '');
  for (const para of text.split('\n')) {
    if (para.length > 40 && QUOTE_MARK.test(para) && SAYING.test(para)) {
      for (const m of para.matchAll(QUOTE_AFTER)) push(m[1], m[2] || m[4], m[3] || m[5], offset + m.index);
      for (const m of para.matchAll(QUOTE_BEFORE)) push(m[3], m[1], m[2], offset + m.index);
    }
    offset += para.length + 1;
  }
  if (!found.length) return found;
  const seen = new Set();
  const out = [];
  const full = new Map(); // surname -> the full name used in this piece
  for (const f of found.sort((a, b) => a.index - b.index)) {
    let name = f.name;
    // Surname-only attributions take the full name used elsewhere in the piece.
    if (!name.includes(' ')) {
      if (!full.has(name)) {
        const m = text.match(new RegExp(`\\b(${NAME_WORD}(?:\\s${NAME_WORD})?)\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
        const p = m && personName(`${m[1]} ${name}`);
        full.set(name, p && p.name.includes(' ') ? p.name : null);
      }
      name = full.get(name);
      if (!name) continue;
    }
    const key = f.text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: f.text, name, role: f.role });
  }
  return out;
}

export const personKey = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Two quotes are "the same line" when their first dozen words match.
const lineKey = (text) => tokens(text).slice(0, 12).join(' ');

// ---- Worker side: an in-memory index of every quote in the window ----

export function createQuoteIndex() {
  return { lastId: 0, quotes: [], at: 0 };
}

// Reads articles added since the last pass and drops what left the window.
export function refreshQuotes(db, idx, { now = Date.now(), days = WINDOW_DAYS } = {}) {
  const since = now - days * DAY;
  // The first pass reads the window by date; later ones only rows added since
  // (by id, so spidered pages dated earlier in the window are picked up too).
  // `hidden` is checked per row: on its index SQLite reads the whole table.
  const top = idx.lastId ? 0 : db.prepare('SELECT MAX(id) AS n FROM docs').get().n || 0;
  const cols = 'id, url, title, description, body, site, source, published_at AS at';
  const rows = idx.lastId
    ? db.prepare(`SELECT ${cols} FROM docs WHERE id > ? AND +type = 'article' AND +hidden = 0 AND +published_at >= ? AND +published_at <= ? AND ${EN} AND length(body) > 400`).all(idx.lastId, since, now + 3600e3)
    : db.prepare(`SELECT ${cols} FROM docs WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND +hidden = 0 AND ${EN} AND length(body) > 400`).all(since, now + 3600e3);
  idx.lastId = Math.max(idx.lastId, top);
  for (const r of rows) {
    idx.lastId = Math.max(idx.lastId, r.id);
    if (!isAiRelated(`${r.title} ${r.description || ''}`)) continue;
    for (const q of extractQuotes(r.body)) {
      idx.quotes.push({ ...q, key: personKey(q.name), line: lineKey(q.text), doc: r.id, url: r.url, title: r.title, site: r.site, source: r.source || r.site, at: r.at });
    }
  }
  if (rows.length) idx.quotes.sort((a, b) => a.at - b.at);
  idx.quotes = idx.quotes.filter((q) => q.at >= since);
  idx.at = now;
  return idx;
}

const mode = (xs) => {
  const m = new Map();
  for (const x of xs) if (x) m.set(x, (m.get(x) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

// Same line, many outlets: one entry per line, with every outlet carrying it.
function groupLines(quotes) {
  const lines = new Map();
  for (const q of quotes) {
    const k = `${q.key}|${q.line}`;
    let g = lines.get(k);
    if (!g) lines.set(k, (g = { text: q.text, name: q.name, key: q.key, role: q.role, first: q, sites: new Set(), copies: [] }));
    if (!g.role && q.role) g.role = q.role;
    if (q.at < g.first.at) g.first = q;
    if (!g.sites.has(q.site)) g.copies.push({ url: q.url, title: q.title, source: q.source, site: q.site, at: q.at });
    g.sites.add(q.site);
  }
  return [...lines.values()].map((g) => ({
    text: g.text,
    name: g.name,
    key: g.key,
    role: g.role,
    at: g.first.at,
    url: g.first.url,
    title: g.first.title,
    source: g.first.source,
    outlets: g.sites.size,
    copies: g.copies.sort((a, b) => a.at - b.at).slice(0, 6),
  }));
}

const spark = (quotes, now, days) => {
  const out = new Array(days).fill(0);
  for (const q of quotes) {
    const d = Math.floor((now - q.at) / DAY);
    if (d >= 0 && d < days) out[days - 1 - d]++;
  }
  return out;
};

// People quoted at least twice from two outlets, most-quoted first, and the
// lines carried most widely in the last week.
export function computeQuotes(idx, { now = Date.now(), days = 30, q = '' } = {}) {
  const since = now - days * DAY;
  let quotes = idx.quotes.filter((x) => x.at >= since);
  const needle = q.trim().toLowerCase();
  const byPerson = new Map();
  for (const x of quotes) {
    let p = byPerson.get(x.key);
    if (!p) byPerson.set(x.key, (p = []));
    p.push(x);
  }
  let people = [...byPerson.values()]
    .map((qs) => ({ qs, sites: new Set(qs.map((x) => x.site)) }))
    .filter(({ qs, sites }) => qs.length >= 2 && sites.size >= 2)
    .map(({ qs, sites }) => {
      const ents = new Map();
      for (const x of qs) for (const k of extractEntities(`${x.text} ${x.title}`).keys()) ents.set(k, (ents.get(k) || 0) + 1);
      return {
        key: qs[0].key,
        name: mode(qs.map((x) => x.name)),
        role: mode(qs.map((x) => x.role)),
        quotes: new Set(qs.map((x) => x.line)).size,
        articles: new Set(qs.map((x) => x.doc)).size,
        outlets: sites.size,
        last: Math.max(...qs.map((x) => x.at)),
        spark: spark(qs, now, days),
        about: [...ents].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key]) => ({ key, label: topicLabel(key) })),
      };
    })
    .sort((a, b) => b.articles - a.articles || b.outlets - a.outlets);
  if (needle) {
    people = people.filter((p) => `${p.name} ${p.role || ''} ${p.about.map((a) => a.label).join(' ')}`.toLowerCase().includes(needle));
    quotes = quotes.filter((x) => `${x.name} ${x.text}`.toLowerCase().includes(needle));
  }
  const weekAgo = now - 7 * DAY;
  const lines = groupLines(quotes.filter((x) => x.at >= weekAgo))
    .filter((l) => l.outlets >= 2 || needle)
    .sort((a, b) => b.outlets - a.outlets || b.at - a.at)
    .slice(0, 8);
  return {
    days,
    generatedAt: now,
    q: needle,
    totals: { quotes: quotes.length, people: people.length, lines: new Set(quotes.map((x) => `${x.key}|${x.line}`)).size },
    lines,
    people: people.slice(0, 60),
  };
}

// One person: every line they're quoted saying, what about, and where.
export function computePerson(idx, { key, now = Date.now(), days = WINDOW_DAYS } = {}) {
  const since = now - days * DAY;
  const qs = idx.quotes.filter((x) => x.key === key && x.at >= since);
  if (!qs.length) return null;
  const lines = groupLines(qs).sort((a, b) => b.at - a.at);
  const ents = new Map();
  for (const l of lines) for (const k of extractEntities(l.text).keys()) ents.set(k, (ents.get(k) || 0) + 1);
  const outlets = new Map();
  for (const x of qs) outlets.set(x.source, (outlets.get(x.source) || 0) + 1);
  const roles = new Map();
  for (const x of qs) if (x.role) roles.set(x.role, (roles.get(x.role) || 0) + 1);
  // Others quoted in the same articles: who they're in the story with.
  const docs = new Set(qs.map((x) => x.doc));
  const alongside = new Map();
  for (const x of idx.quotes) {
    if (x.key === key || !docs.has(x.doc)) continue;
    const a = alongside.get(x.key) || { key: x.key, name: x.name, n: 0, docs: new Set() };
    a.docs.add(x.doc);
    a.n = a.docs.size;
    alongside.set(x.key, a);
  }
  return {
    key,
    name: mode(qs.map((x) => x.name)),
    role: mode(qs.map((x) => x.role)),
    roles: [...roles].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => r),
    days,
    generatedAt: now,
    totals: { lines: lines.length, articles: docs.size, outlets: new Set(qs.map((x) => x.site)).size, first: qs[0].at, last: qs[qs.length - 1].at },
    daily: spark(qs, now, days),
    about: [...ents].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ key: k, label: topicLabel(k), n })),
    outlets: [...outlets].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
    alongside: [...alongside.values()].filter((a) => a.n >= 1).sort((a, b) => b.n - a.n).slice(0, 6).map(({ key: k, name, n }) => ({ key: k, name, n })),
    lines: lines.slice(0, 40),
  };
}

let shared = null;
export function quoteIndex(db) {
  shared ||= createQuoteIndex();
  if (Date.now() - shared.at > 5 * 60e3) refreshQuotes(db, shared);
  return shared;
}

// ---- Server side ----

export const quotesQuery = (q = '') => cachedJob(`quotes:${q}`, { kind: 'quotes', q }, 10 * 60e3);
export const personQuery = (key) => cachedJob(`person:${key}`, { kind: 'person', key }, 10 * 60e3);
