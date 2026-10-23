// Talent moves: who joined, left or was hired away between AI labs and big
// tech, read from headlines. "Former OpenAI head of data centers joins
// Nvidia", "Meta poaches MongoDB's CEO", "Long-time OpenAI exec departs".
//
// A move needs a person (a known name, a capitalised two- or three-word name,
// or a role: "head of data centers", "CTO", "researchers") and at least one
// known company. Companies joining programmes, products "joining the race"
// and partner networks are not moves. The same person and destination within
// a month across outlets is one move. From the moves: flows between
// companies, and each company's arrivals, departures and net.

import { splitOutlet } from '../pipeline/text.js';
import { vocabNodes } from './graph.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const TALENT_DAYS = 365;

const ROLE = /\b(?:head|chief|vp|svp|evp|vice president|director|executive|exec|execs|researchers?|scientists?|engineers?|founders?|co-?founder|cto|ceo|cfo|coo|cpo|ciso|president|lead|leader|adviser|advisor|veteran|staff|staffers|employees|team|talent|architect|officer|partner at|manager|designer|economist|policy chief|general counsel)\b/i;
const NOT_PERSON = /\b(?:agent|agents|model|models|app|chatbot|program|programme|network|initiative|marketplace|lineup|race|platform|fund|alliance|coalition|consortium|group of companies|bot|assistant|startup|company|firm|stock|shares)\b/i;
const NOT_MOVE_AFTER = /^(?:['’]s?)?\s*(?:new\s)?(?:[\w-]+\s){0,3}?(?:program|programme|partner|network|trust|council|marketplace|lineup|race|initiative|alliance|coalition|cybersecurity program|board of)\b/i;
const NAME = /^(?:[A-Z][a-zA-Z'’.-]+)(?:\s[A-Z][a-zA-Z'’.-]+){1,2}$/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeParser(orgs, people = []) {
  // Longest first so "Google DeepMind" wins over "Google".
  const aliases = orgs.flatMap((o) => o.aliases.map((a) => [a, o])).sort((a, b) => b[0].length - a[0].length);
  const ORG = `(?:${aliases.map(([a]) => esc(a)).join('|')})`;
  const byAlias = new Map(aliases.map(([a, o]) => [a.toLowerCase(), o]));
  const orgOf = (s) => byAlias.get(s.trim().toLowerCase()) || null;
  const anyOrg = new RegExp(`(?<![\\w])${ORG}(?![\\w])`);
  const findOrg = (s) => {
    const m = anyOrg.exec(s);
    return m ? orgOf(m[0]) : null;
  };
  const FORMER = new RegExp(`^(?:(?:former|ex-|longtime|long-time|top|veteran|senior|key|star)\\s?)+(?<org>${ORG})(?:['’]s)?\\s`, 'i');
  const FROM = new RegExp(`\\bfrom (?<org>${ORG})\\b`);
  const POSS = new RegExp(`^(?<org>${ORG})['’]s\\s(?<rest>.+)$`);
  const OWNED = new RegExp(`['’]s ${ORG}\\b`);
  const FOR_ORG = new RegExp(`\\b(?:for|to join|joins|to) (?<org>${ORG})\\b`);
  const peopleRe = people.length ? new RegExp(`(?<![\\w])(?:${people.map((p) => esc(p)).join('|')})(?![\\w])`) : null;

  // Verbs are found with small patterns; companies are then looked up by
  // their first word (a pattern joining every alias backtracks for seconds).
  const JOIN = /^(?<who>.+?) (?:joins|is joining|to join|will join|moves to|jumps to|heads to|defects to|returns to|rejoins|signs with) (?<rest>.+)$/;
  const HIRE = /^(?<head>.+?) (?:hires|has hired|poaches|poached|taps|names|appoints|recruits|lures|snags|brings on|brings in|adds|nabs|grabs|picks) (?<who>.+)$/;
  const LEAVE = /^(?<who>.+?) (?:leaves|departs|exits|quits|is leaving|to leave|steps down (?:at|from)|resigns from|has left) (?<rest>.+)$/;
  const LEAVE2 = /^(?<head>.+?) (?:leaves|departs|exits|quits|steps down|resigns|is out|is leaving|to leave|has left)\b(?<after>.*)$/;
  const byFirst = new Map();
  for (const [a, o] of aliases) {
    const f = a.split(/[^\w-]/)[0].toLowerCase();
    (byFirst.get(f) || byFirst.set(f, []).get(f)).push([a, o]);
  }
  // The company at the start of s, and what follows it.
  const orgAt = (s) => {
    for (const [a, o] of byFirst.get(s.split(/[^\w-]/)[0].toLowerCase()) || []) {
      if (s.length >= a.length && s.slice(0, a.length).toLowerCase() === a.toLowerCase() && !/[\w-]/.test(s[a.length] || '')) return { org: o, after: s.slice(a.length) };
    }
    return null;
  };

  function person(raw) {
    // Headline lead-ins: "Google's AI reshuffle: …", "Amazon says …", "reportedly".
    let who = raw.replace(/^.*?:\s+/, '').replace(/^(?:says|confirms|announces)\s+/i, '').replace(/\s+reportedly$/i, '').trim().replace(/[,:]$/, '');
    if (OWNED.test(who) || / for (?:more|its|a|an|the)\b/i.test(who)) return null; // "Elon Musk's SpaceX for compute"
    let from = null;
    // "Former OpenAI head of …", "ex-Google researcher", "OpenAI veteran"
    const former = FORMER.exec(who);
    if (former) from = orgOf(former.groups.org);
    const fromM = FROM.exec(who);
    if (fromM) {
      from = orgOf(fromM.groups.org);
      who = who.slice(0, fromM.index).trim();
    }
    const possessive = POSS.exec(who);
    if (possessive) {
      from ||= orgOf(possessive.groups.org);
      who = possessive.groups.rest;
    }
    // "… as its VP of sales": role after the name.
    let role = null;
    const as = / (?:as|to lead|to head|to run|to oversee) (?:its |the |a |an |new )?(.+)$/i.exec(who);
    if (as) {
      role = as[1];
      who = who.slice(0, as.index).trim();
    }
    const isKnown = peopleRe?.test(who);
    const looksName = NAME.test(who) && !findOrg(who);
    const isRole = ROLE.test(who);
    // "Nobel laureate John Jumper": a name at the end counts too.
    const tailName = /(?:^|\s)[A-Z][a-z'’.-]+\s[A-Z][a-zA-Z'’-]+$/.test(who) && !findOrg(who.split(/\s+/).slice(-2).join(' '));
    if (NOT_PERSON.test(who) && !isKnown) return null;
    if (!isKnown && !looksName && !isRole && !tailName) return null;
    if (who.split(' ').length > 9) return null;
    // A bare company name isn't a person; a partner deal isn't a hire.
    if (orgOf(who) || /\b(?:partner|supplier|provider|vendor|customer)\b/i.test(role || '')) return null;
    // "safety leader David Robinson" -> David Robinson, safety leader.
    let name = null;
    const known = isKnown ? peopleRe.exec(who) : null;
    if (looksName) name = who;
    else {
      // The trailing run of capitalised words that aren't roles or companies.
      const words = who.split(/\s+/);
      let i = words.length;
      while (i > 0 && /^[A-Z][a-zA-Z'’.-]+$/.test(words[i - 1]) && !ROLE.test(words[i - 1]) && !orgOf(words[i - 1]) && words.length - i < 3) i--;
      const tail = words.slice(i);
      if (tail.length >= 2) {
        name = tail.join(' ');
        role ||= words.slice(0, i).join(' ').trim() || null;
      } else if (known) {
        name = known[0];
        role ||= who.replace(known[0], '').trim() || null;
      }
    }
    if (!name) role ||= who.replace(/^(?:former|ex-)\s+/i, '');
    role = role?.replace(/[.;].*$/, '').replace(/\s+(?:reportedly|after|following|amid|as|ahead of|to replace|who)\b.*$/i, '').replace(/^(?:former|ex-)\s+/i, '').trim() || null;
    return { who: name || who.replace(/\s+(?:ahead of|amid|after|reportedly)\b.*$/i, ''), name, role: role === name ? null : role, from };
  }

  return function parse(rawTitle) {
    const title = splitOutlet(rawTitle.replace(/\s+\|\s+[^|]{2,40}$/, '')).title.replace(/[‘’]/g, "'").trim();
    let m = JOIN.exec(title);
    const toOrg = m && orgAt(m.groups.rest);
    if (toOrg) {
      if (NOT_MOVE_AFTER.test(toOrg.after.trim())) return null;
      const p = person(m.groups.who);
      return p && { kind: 'join', who: p.who, name: p.name, role: p.role, from: p.from?.key || null, to: toOrg.org.key };
    }
    m = HIRE.exec(title);
    if (m && orgOf(m.groups.head)) {
      m.groups.to = m.groups.head;
      const p = person(m.groups.who);
      // "Apple names X as CFO" with no earlier employer is an appointment, not a move.
      const appoint = /^\S+ (?:names|appoints|taps|picks)\b/i.test(title) && !p?.from;
      return p && { kind: appoint ? 'appoint' : 'hire', who: p.who, name: p.name, role: p.role, from: p.from?.key || null, to: orgOf(m.groups.to)?.key };
    }
    let who = null;
    let from = null;
    let after = '';
    m = LEAVE.exec(title);
    const fromOrg = m && orgAt(m.groups.rest);
    if (fromOrg) {
      who = m.groups.who;
      from = fromOrg.org;
      after = fromOrg.after;
    } else {
      m = LEAVE2.exec(title);
      const head = m && orgAt(m.groups.head);
      if (head) {
        from = head.org;
        who = head.after.replace(/^['’]s?\s*/, '').trim();
        after = m.groups.after;
      }
    }
    if (!who) return null;
    if (after && NOT_MOVE_AFTER.test(after.trim())) return null;
    // "DeepMind loses another researcher as John Jumper", "shake-up continues as developer division chief"
    const as = /\bas (?<rest>.+)$/.exec(who);
    if (as) who = as.groups.rest;
    const p = person(who);
    if (!p) return null;
    const to = FOR_ORG.exec(after || '');
    return { kind: 'leave', who: p.who, name: p.name, role: p.role, from: from.key, to: to ? orgOf(to.groups.org)?.key : null };
  };
}

const personKey = (s) => s.toLowerCase().replace(/^(?:former|ex-|longtime|long-time|top|veteran|senior)\s+/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function computeTalent(db, { now = Date.now(), days = TALENT_DAYS } = {}) {
  const since = now - days * DAY;
  const nodes = vocabNodes();
  const orgs = nodes.filter((n) => n.type === 'org');
  const people = nodes.filter((n) => n.type === 'person').flatMap((n) => n.aliases);
  const label = new Map(orgs.map((o) => [o.key, o.label]));
  const parse = makeParser(orgs, people);
  // Only headlines with a move verb (FTS, stemmed): a year of titles read
  // row by row costs 2.6-12 s; these few thousand cost ~0.2 s.
  const verbs = 'join OR joins OR rejoin OR hire OR hires OR poach OR poaches OR tap OR taps OR name OR names OR appoint OR recruit OR lure OR snag OR nab OR grab OR pick OR leave OR leaves OR depart OR exit OR quit OR resign OR "step down" OR defect OR "move to" OR "heads to" OR "jumps to" OR "signs with" OR "is out"';
  const rows = db.prepare(`SELECT url, title, source, site, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(`title : (${verbs})`, since, now + 5 * 60e3);
  const VERB = /\b(?:joins|joining|join|moves to|jumps to|heads to|defects|returns to|rejoins|signs with|hires|hired|poach|taps|names|appoints|recruits|lures|snags|brings|adds|nabs|grabs|picks|leaves|leaving|departs|exits|quits|steps down|resigns|left|is out)\b/i;
  const found = [];
  for (const r of rows) {
    if (!VERB.test(r.title)) continue;
    const m = parse(r.title);
    if (!m || (!m.from && !m.to) || m.from === m.to) continue;
    found.push({ ...m, at: r.at, url: r.url, title: r.title, source: r.source || r.site });
  }
  // One move per person and destination (or origin) within a month.
  found.sort((a, b) => a.at - b.at);
  const moves = [];
  for (const f of found) {
    const k = personKey(f.name || f.who);
    const same = moves.find((m) => (m.key === k || (!f.name && !m.name && m.role && f.role && personKey(m.role) === personKey(f.role))) && f.at - m.last < 45 * DAY && ((f.to && m.to === f.to) || (f.from && m.from === f.from)));
    if (same) {
      same.last = f.at;
      same.outlets.add(f.source);
      same.from ||= f.from;
      same.to ||= f.to;
      same.role ||= f.role;
      if (f.name && !same.name) { same.name = f.name; same.who = f.name; same.key = k; }
      continue;
    }
    // A named person's earlier unnamed headline ("OpenAI data center chief leaves") folds in.
    if (f.name) {
      const unnamed = moves.find((m) => !m.name && f.at - m.last < 45 * DAY && m.from === f.from && m.to === f.to && m.role && f.role && personKey(f.role).includes(personKey(m.role)));
      if (unnamed) {
        Object.assign(unnamed, { name: f.name, who: f.name, key: k, last: f.at });
        unnamed.outlets.add(f.source);
        continue;
      }
    }
    moves.push({ key: k, who: f.who, name: f.name || null, role: f.role, from: f.from, to: f.to, kind: f.kind, at: f.at, last: f.at, url: f.url, title: f.title, source: f.source, outlets: new Set([f.source]) });
  }

  const flows = new Map();
  const orgStats = new Map();
  const stat = (k) => orgStats.get(k) || orgStats.set(k, { key: k, label: label.get(k) || k, arrivals: 0, departures: 0 }).get(k);
  for (const m of moves) {
    if (m.kind === 'appoint') continue;
    if (m.from) stat(m.from).departures++;
    if (m.to) stat(m.to).arrivals++;
    if (m.from && m.to) {
      const k = `${m.from}>${m.to}`;
      flows.set(k, (flows.get(k) || 0) + 1);
    }
  }
  return {
    days,
    since,
    generatedAt: now,
    total: moves.length,
    moves: moves.sort((a, b) => b.at - a.at).slice(0, 300).map(({ key, last, outlets, ...m }) => ({
      ...m,
      fromLabel: m.from ? label.get(m.from) || m.from : null,
      toLabel: m.to ? label.get(m.to) || m.to : null,
      outlets: outlets.size,
    })),
    flows: [...flows].map(([k, n]) => {
      const [from, to] = k.split('>');
      return { from, to, fromLabel: label.get(from) || from, toLabel: label.get(to) || to, n };
    }).sort((a, b) => b.n - a.n),
    orgs: [...orgStats.values()].map((o) => ({ ...o, net: o.arrivals - o.departures })).sort((a, b) => b.arrivals + b.departures - (a.arrivals + a.departures)).slice(0, 24),
  };
}

export const talentQuery = () => cachedJob('talent', { kind: 'talent' }, TTL_MS);
