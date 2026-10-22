// Jump-to index for the command palette (⌘K) and the reading list's status.
//
// One small in-memory index of everything the site has a page or panel for,
// rebuilt when the feed changes: topics, names from the entity graph, X
// accounts, releases, emerging themes, live stories and markets. A query
// matches when every word in it starts a word of the entry ("cl du" finds
// Claude Duet); entries rank by how well they match, then by kind and size.
//
// savedStatus() tells the reading list how each saved story has moved on
// since it was saved: still live, sources now, breaking.

import { topicKeys, topicLabel } from './topics.js';
import { loggedStory } from './stories.js';

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9@#+.]+/).map((w) => w.replace(/^[.]+|[.]+$/g, '')).filter(Boolean);

const money = (v = 0) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `$${Math.round(v / 1e3)}k`);

// Kind priors: a topic page or a name is usually what a short query means.
const PRIOR = { topic: 3, name: 2.6, account: 2.4, release: 2.2, theme: 2, story: 1.4, market: 1.2 };

export function buildIndex({ stories = [], releases = [], markets = [], posts = [], graph = null, themes = [], breaking = [] } = {}) {
  const out = [];
  const add = (e) => out.push({ ...e, w: words(`${e.label} ${e.also || ''}`) });
  for (const key of topicKeys()) add({ type: 'topic', label: topicLabel(key), href: `#topic/${key}`, sub: 'Topic page: its share of coverage', size: 0 });
  for (const n of graph?.nodes || []) add({ type: 'name', label: n.label, href: `#graph/${n.key}`, sub: `Connections: ${n.n} articles in ${graph.days || 30} days`, size: Math.log10(1 + n.n) });
  const accounts = new Map();
  for (const p of posts) {
    if (!p.handle) continue;
    const a = accounts.get(p.handle) || { handle: p.handle, name: p.author || p.handle, avatar: p.avatar || null, n: 0 };
    a.n++;
    accounts.set(p.handle, a);
  }
  for (const a of accounts.values()) add({ type: 'account', label: a.name, also: `@${a.handle} ${a.handle}`, handle: a.handle, href: `#x`, sub: `@${a.handle}`, avatar: a.avatar, size: Math.log10(1 + a.n) });
  for (const r of releases) add({ type: 'release', label: r.name, also: `${r.provider || ''} ${r.org || ''}`, href: r.story?.sid ? `#story/${r.story.sid}` : r.url, external: !r.story?.sid, sub: [r.provider, r.open ? 'open weights' : null].filter(Boolean).join(' · '), date: r.date, size: r.notable ? 1 : 0 });
  for (const t of themes) add({ type: 'theme', label: [].concat(t.name || t.headline || []).join(' · '), href: `#theme/${t.id}`, sub: t.headline ? `Emerging · ${t.headline}` : 'Emerging', size: 0.5 });
  const hot = new Set(breaking.map((b) => b.sid));
  for (const s of stories.slice(0, 300)) {
    if (!s.sid) continue;
    add({ type: 'story', label: s.title, href: `#story/${s.sid}`, sub: `${s.lead?.source || ''}${s.sources?.length > 1 ? ` · ${s.sources.length} sources` : ''}`, breaking: hot.has(s.sid), date: s.publishedAt, size: Math.log10(1 + (s.sources?.length || 1)) });
  }
  for (const m of markets.slice(0, 150)) add({ type: 'market', label: m.title, href: m.url, external: true, sub: `Polymarket · ${money(m.volume)} traded`, size: Math.log10(1 + (m.volume || 0)) / 6 });
  return out;
}

export function jumpSearch(index, query, { limit = 12 } = {}) {
  const qw = words(query);
  if (!qw.length) return [];
  const phrase = qw.join(' ');
  const scored = [];
  for (const e of index) {
    let exact = 0;
    let ok = true;
    for (const t of qw) {
      let hit = false;
      for (const w of e.w) {
        if (w === t || (t[0] === '@' && w === t.slice(1))) { exact++; hit = true; break; }
        if (w.startsWith(t.replace(/^@/, ''))) hit = true;
      }
      if (!hit) { ok = false; break; }
    }
    if (!ok) continue;
    const label = e.label.toLowerCase();
    // Whole-label and leading matches beat a word deep in a headline.
    const lead = label === phrase ? 3 : label.startsWith(phrase) ? 1.5 : e.w[0]?.startsWith(qw[0]) ? 0.6 : 0;
    const brevity = 1 / Math.sqrt(e.w.length);
    scored.push([PRIOR[e.type] + lead + exact * 0.4 + brevity + e.size * 0.5 + (e.breaking ? 1 : 0), e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  // No more than five of one kind, so a common word can't fill the list with headlines.
  const per = {};
  const res = [];
  for (const [, { w, size, also, ...e }] of scored) {
    per[e.type] = (per[e.type] || 0) + 1;
    if (per[e.type] > 5) continue;
    res.push(e);
    if (res.length >= limit) break;
  }
  return res;
}

// The reading list's view of saved stories: what each looks like now.
export function savedStatus(store, sids) {
  const hot = new Set((store.snapshot.breaking || []).map((b) => b.sid));
  const live = new Map((store.snapshot.stories || []).concat(store.snapshot.tech || []).filter((s) => s.sid).map((s) => [s.sid, s]));
  return sids.map((sid) => {
    const s = live.get(sid);
    if (s) return { sid, title: s.title, url: s.url, image: s.image || null, source: s.lead?.source || null, sources: s.sources.length, updatedAt: s.updatedAt || s.publishedAt, live: true, breaking: hot.has(sid) };
    const old = loggedStory(sid);
    if (!old) return { sid, gone: true };
    return { sid, title: old.title, url: old.url, image: old.image, source: null, sources: old.urls.length, updatedAt: old.updatedAt, live: false, breaking: false };
  });
}
