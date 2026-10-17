// Turns raw items from every source into stories: duplicates and near-duplicates
// are merged, each story gets a heat score, topics, entities and matching
// Polymarket markets.

import { canonicalUrl, tokens, hostOf } from './text.js';
import { extractEntities, topicsFor, ENTITIES } from './classify.js';

const KIND_RANK = { lab: 5, press: 4, analysis: 3, community: 2, social: 1 };

function titleTokens(item) {
  return new Set(tokens(item.title).filter((t) => t.length > 2 || /\d/.test(t)));
}

class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) x = this.p[x] = this.p[this.p[x]]; return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

export function clusterItems(items) {
  const n = items.length;
  const dsu = new DSU(n);
  const toks = items.map(titleTokens);

  // Exact link matches: same article reached through different sources.
  const byUrl = new Map();
  items.forEach((it, i) => {
    for (const u of [it.url, it.linkUrl]) {
      if (!u || /news\.google\.com|x\.com|bsky\.app|reddit\.com|ycombinator\.com/.test(u) && u !== it.linkUrl) continue;
      const key = canonicalUrl(u);
      if (byUrl.has(key)) dsu.union(byUrl.get(key), i);
      else byUrl.set(key, i);
    }
  });

  // Near-duplicate titles, found through an inverted index of rarer tokens.
  const df = new Map();
  toks.forEach((s) => s.forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const index = new Map();
  toks.forEach((s, i) => {
    for (const t of s) {
      if (df.get(t) > Math.max(6, n * 0.05)) continue;
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(i);
    }
  });
  for (let i = 0; i < n; i++) {
    const shared = new Map();
    for (const t of toks[i]) {
      for (const j of index.get(t) || []) if (j > i) shared.set(j, (shared.get(j) || 0) + 1);
    }
    for (const [j, count] of shared) {
      if (count < 3) continue;
      if (Math.abs((items[i].publishedAt || 0) - (items[j].publishedAt || 0)) > 48 * 3600e3) continue;
      const union = toks[i].size + toks[j].size - count;
      const jaccard = count / union;
      const overlap = count / Math.min(toks[i].size, toks[j].size);
      if (jaccard >= 0.4 || (overlap >= 0.6 && count >= 4) || (jaccard >= 0.3 && count >= 4)) dsu.union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((it, i) => {
    const r = dsu.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  return [...groups.values()].map(buildStory);
}

function pickLead(group) {
  // Prefer a first-party or press headline; social posts are kept as reactions.
  return [...group].sort((a, b) => {
    const k = (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0);
    if (k) return k;
    if (!!b.summary !== !!a.summary) return b.summary ? 1 : -1;
    return (a.publishedAt || 0) - (b.publishedAt || 0);
  })[0];
}

function buildStory(group) {
  const lead = pickLead(group);
  const times = group.map((i) => i.publishedAt).filter(Boolean);
  const text = group.map((i) => `${i.title} ${i.summary || ''}`).join(' ');
  const entities = extractEntities(`${lead.title} ${lead.summary || ''} ${group.slice(0, 6).map((i) => i.title).join(' ')}`);
  const sources = [];
  const seen = new Set();
  for (const it of [...group].sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0))) {
    const key = it.platform === 'x' || it.platform === 'bluesky' ? `${it.platform}:${it.handle}` : it.source;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      name: it.platform === 'x' ? `@${it.handle}` : it.source,
      url: it.discussionUrl || it.url,
      platform: it.platform,
      host: it.sourceHost || hostOf(it.url),
      kind: it.kind,
      author: it.author,
      avatar: it.avatar,
      text: it.platform === 'x' || it.platform === 'bluesky' ? it.title : undefined,
      publishedAt: it.publishedAt,
      engagement: it.engagement,
    });
  }
  const image = lead.image || group.find((i) => i.image && i.platform !== 'reddit')?.image || null;
  return {
    id: lead.id,
    title: lead.title,
    url: lead.url,
    linkUrl: lead.linkUrl || null,
    summary: lead.summary || group.find((i) => i.summary && i.platform !== 'x')?.summary || '',
    image,
    lead: { sourceHost: lead.sourceHost || null, source: lead.platform === 'x' ? `@${lead.handle}` : lead.source, platform: lead.platform, kind: lead.kind, author: lead.author, avatar: lead.avatar, handle: lead.handle, host: hostOf(lead.url) },
    publishedAt: times.length ? Math.min(...times) : Date.now(),
    updatedAt: times.length ? Math.max(...times) : Date.now(),
    sources,
    topics: topicsFor(text),
    entities: [...entities.entries()].filter(([, strong]) => strong).map(([k]) => k),
    weakEntities: [...entities.keys()],
    _group: group,
  };
}

export function scoreStory(story, now = Date.now()) {
  let base = 0;
  for (const it of story._group) {
    const eng = it.engagement?.score || 0;
    const engBoost = it.platform === 'hn' ? Math.log1p(eng) / 2.5 : it.platform === 'reddit' ? Math.log1p(eng) / 3.5 : Math.log1p(eng) / 4;
    base += (it.weight || 1) * (1 + engBoost);
  }
  const distinct = new Set(story.sources.map((s) => s.name)).size;
  const platforms = new Set(story.sources.map((s) => s.platform)).size;
  const ageH = Math.max(0, (now - story.publishedAt) / 3600e3);
  const freshness = Math.exp(-ageH / 9);
  // Continued coverage keeps a story warm even if it broke a while ago.
  const momentum = Math.exp(-Math.max(0, (now - story.updatedAt) / 3600e3) / 6);
  const marketBoost = story.markets?.length ? 1.15 : 1;
  return +(base * Math.pow(distinct, 0.55) * (1 + 0.15 * (platforms - 1)) * (0.65 * freshness + 0.35 * momentum) * marketBoost).toFixed(3);
}

// ---- Polymarket correlation ----

const SUBJECTS = new Set(['openai', 'anthropic', 'google', 'meta', 'xai', 'musk', 'microsoft', 'apple', 'amazon', 'nvidia', 'amd', 'tsmc', 'deepseek', 'qwen', 'mistral', 'perplexity', 'huggingface', 'cursor', 'ssi', 'tesla', 'figure', 'china']);
const THEMES = new Set(['agi', 'ipo', 'regulation', 'funding', 'benchmark']);
const GENERIC = new Set(['will', 'by', 'end', 'before', 'after', 'month', 'october', 'november', 'december', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', '2025', '2026', '2027', '2028', 'ai', 'best', 'company', 'top', 'model', 'models', 'which', 'who', 'hit', 'reach', 'yes', 'no', 'least', 'than', 'less', 'higher', 'lower', 'release', 'released', 'announce', 'announces']);

// Company names are already counted as entities; don't double count them as words.
const ALIAS_WORDS = new Set(Object.values(ENTITIES).flat().flatMap((a) => a.split(/\s+/)));

function significant(text) {
  return new Set(tokens(text).filter((t) => !GENERIC.has(t) && !ALIAS_WORDS.has(t) && (t.length > 3 || /\d/.test(t))));
}

export function matchMarkets(stories, markets) {
  const prepared = markets.map((m) => {
    const titleEnts = extractEntities(m.title);
    const subjects = m.entities.filter((e) => SUBJECTS.has(e));
    return {
      m,
      toks: significant(m.title),
      subjects: new Set(subjects),
      // Markets naming many companies ("Which company has the best model?")
      // are about the race, not any one company; a shared name counts less.
      subjectWeight: subjects.length > 2 ? 0.75 : 2,
      themes: new Set([...titleEnts.keys()].filter((e) => THEMES.has(e))),
    };
  });
  for (const s of stories) {
    const ents = new Set(s.entities);
    const themesInStory = new Set(s.entities.filter((e) => THEMES.has(e)));
    const sToks = significant(`${s.title} ${s.summary}`);
    const scored = [];
    for (const p of prepared) {
      const sharedSubjects = [...p.subjects].filter((e) => ents.has(e));
      if (!sharedSubjects.length) continue;
      const sharedThemes = [...p.themes].filter((e) => themesInStory.has(e));
      let tokOverlap = 0;
      for (const t of p.toks) if (sToks.has(t)) tokOverlap++;
      // A shared company alone is too loose ("Google" matches everything);
      // require a theme or concrete words in common too.
      if (sharedThemes.length === 0 && tokOverlap < 2) continue;
      const score = sharedSubjects.length * p.subjectWeight + sharedThemes.length * 2.5 + tokOverlap * 1.25;
      if (score < (sharedThemes.length ? 4.5 : 5.2)) continue;
      scored.push({ score, m: p.m });
    }
    scored.sort((a, b) => b.score - a.score || b.m.volume24h - a.m.volume24h);
    s.markets = scored.slice(0, 2).map(({ m, score }) => ({ id: m.id, relevance: +score.toFixed(1) }));
  }
}
