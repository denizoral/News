import { createSearch, spiderLine } from './search.js';

// Frontier Wire client. Loads the snapshot, renders three views, and keeps
// itself current over Server-Sent Events (or polling when hosted statically).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  data: null,
  pending: null,
  view: 'news',
  topic: store.get('fw.topic', 'All'),
  kind: store.get('fw.kind', 'all'),
  sort: store.get('fw.sort', 'top'),
  buildFilter: store.get('fw.build', 'all'),
  marketSort: store.get('fw.msort', 'moving'),
  techTopic: store.get('fw.techtopic', 'All'),
  techSort: store.get('fw.techsort', 'top'),
  techLimit: 40,
  relFilter: store.get('fw.relfilter', 'notable'),
  xCat: store.get('fw.xcat', 'all'),
  xHandle: null,
  xq: '',
  x: null, // { key, version, posts, nextBefore, groups, accounts, status }
  q: '',
  entity: null,
  trendHours: 6,
  trend: null, // trending for a non-default window, fetched from the API
  limit: 60,
  open: new Set(),
  read: new Set(store.get('fw.read', [])),
  live: 'connecting',
  mode: 'api',
};

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const isUrlOnly = (s = '') => /^\s*https?:\/\/\S+\s*$/.test(s);
const PLATFORM_HOST = { x: 'x.com', hn: 'news.ycombinator.com', reddit: 'reddit.com', bluesky: 'bsky.app', github: 'github.com', huggingface: 'huggingface.co', producthunt: 'producthunt.com' };
const pct = (p) => (p >= 0.995 ? '>99' : p < 0.01 ? '<1' : Math.round(p * 100)) + '%';
const compact = (n) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Animated swaps of the page (tabs, filters) where the browser supports it.
function transition(update) {
  if (!document.startViewTransition || reducedMotion() || document.hidden) return update();
  document.startViewTransition(update);
}
const time = (ts) => `<time datetime="${new Date(ts).toISOString()}" data-ts="${ts}" title="${new Date(ts).toLocaleString()}">${ago(ts)}</time>`;

function highlight(text) {
  const t = esc(text);
  if (!state.q) return t;
  const re = new RegExp(`(${state.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return t.replace(re, '<mark>$1</mark>');
}

// ---------- DOM patching ----------
// Live updates re-render whole sections. Swapping innerHTML would rebuild every
// node, so images reload and the page flashes each time a source finishes.
// setHtml() diffs instead: nodes whose markup is unchanged stay put, elements
// that changed are patched in place, and only genuinely new nodes are inserted.
// Relative times are ignored when comparing; a timer keeps them current.

const TIME_TEXT = /(<time\b[^>]*>)[^<]*/g;
const sig = (n) => (n.nodeType === 1 ? n.outerHTML.replace(TIME_TEXT, '$1') : n.nodeType === 3 ? `#${n.data}` : '#');
const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-id') : null);

function morph(old, next) {
  if (old.nodeType !== 1) {
    if (old.data !== next.data) old.data = next.data;
    return;
  }
  for (const { name } of [...old.attributes]) if (!next.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of next.attributes) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  if (old.tagName === 'TIME') return;
  morphChildren(old, next);
}

function morphChildren(parent, next) {
  const olds = [...parent.childNodes];
  const bySig = new Map();
  for (const o of olds) {
    const k = sig(o);
    bySig.has(k) ? bySig.get(k).push(o) : bySig.set(k, [o]);
  }
  const used = new Set();
  const take = (o) => (used.add(o), o);
  const result = [...next.childNodes].map((n, i) => {
    const same = bySig.get(sig(n))?.find((o) => !used.has(o));
    if (same) return take(same);
    const key = keyOf(n);
    const match = key != null
      ? olds.find((o) => !used.has(o) && keyOf(o) === key && o.tagName === n.tagName)
      : olds[i] && !used.has(olds[i]) && olds[i].nodeType === n.nodeType && olds[i].nodeName === n.nodeName && keyOf(olds[i]) == null ? olds[i] : null;
    if (match) {
      morph(match, n);
      return take(match);
    }
    return n;
  });
  // Move only what's out of place, so untouched nodes keep running animations.
  result.forEach((n, i) => {
    if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] || null);
  });
  while (parent.childNodes.length > result.length) parent.lastChild.remove();
}

function setHtml(el, html) {
  if (!el || el._html === html) return;
  el._html = html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}

// ---------- Search engine ----------
// Created after the helpers below are defined (function declarations hoist).
let searchUi = null;

// ---------- Data ----------

async function fetchSnapshot() {
  if (state.mode === 'api') {
    try {
      const res = await fetch('api/snapshot', { cache: 'no-cache' });
      if (res.ok) return await res.json();
    } catch { /* fall through to static */ }
    state.mode = 'static';
  }
  const res = await fetch(`data/snapshot.json?t=${Math.floor(Date.now() / 60000)}`);
  if (!res.ok) throw new Error('No snapshot available');
  return res.json();
}

async function refresh({ force = false } = {}) {
  try {
    const next = await fetchSnapshot();
    if (state.data && next.version === state.data.version && next.generatedAt === state.data.generatedAt) return setLive('on');
    const atTop = window.scrollY < 300;
    if (!state.data || force || atTop || state.view !== 'news') {
      state.data = next;
      state.pending = null;
      render();
      if (state.trendHours !== 6) loadTrend({ animate: false });
    } else {
      // Don't reshuffle under someone who is reading; offer the update instead.
      state.pending = next;
      const known = new Set(state.data.stories.map((s) => s.id));
      const fresh = next.stories.slice(0, 80).filter((s) => !known.has(s.id)).length;
      const pill = $('#newPill');
      pill.textContent = fresh ? `Show ${fresh} new ${fresh === 1 ? 'story' : 'stories'}` : 'Show latest';
      pill.hidden = false;
    }
    setLive('on');
  } catch (e) {
    setLive('off');
    if (!state.data) setHtml($('#river'), `<p class="empty">Couldn't load the feed. ${esc(e.message)}. Check that the server is running, then reload.</p>`);
  }
}

function connect() {
  if (state.mode === 'static' || !window.EventSource) {
    setInterval(refresh, 60e3);
    return;
  }
  const es = new EventSource('api/stream');
  es.addEventListener('update', (e) => {
    try { state.latest = JSON.parse(e.data).version; } catch { state.latest = Infinity; }
    scheduleRefresh();
  });
  es.addEventListener('hello', () => setLive('on'));
  es.onerror = () => {
    setLive('off');
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
}

// Updates arrive a few times a minute. A hidden tab fetches nothing and
// catches up once when shown; bursts of updates coalesce into one fetch.
let refreshTimer = null;
function scheduleRefresh() {
  if (document.hidden || state.latest === state.data?.version) return;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 2000);
}
document.addEventListener('visibilitychange', scheduleRefresh);

function setLive(s) {
  state.live = s;
  updateLive();
}
function updateLive() {
  const el = $('#live');
  el.classList.toggle('on', state.live === 'on');
  const label = $('span', el);
  if (state.live !== 'on' || !state.data) label.textContent = state.live === 'off' ? 'Reconnecting' : 'Connecting';
  else label.textContent = `Updated ${ago(state.data.generatedAt)}`;
}

// ---------- Story pieces ----------

const marketById = () => new Map((state.data?.markets || []).map((m) => [m.id, m]));

// Odds bars scale with transform (cheap to animate); [data-odds] lets the
// renderer find values that moved since the last paint and animate them.
const oddsKey = (m, o) => `${m.id}:${o.label}`;
const barHtml = (m, o) => `<span class="rule" aria-hidden="true"><i data-odds="${esc(oddsKey(m, o))}" data-yes="${o.yes}" style="transform:scaleX(${(o.yes || 0).toFixed(3)})"></i></span>`;
const pctHtml = (m, o, tag = 'span', cls = 'pct') => `<${tag} class="${cls}" data-odds="${esc(oddsKey(m, o))}" data-yes="${o.yes}">${pct(o.yes)}</${tag}>`;

const shownOdds = new Map();
function animateOdds() {
  const motion = !reducedMotion();
  const bars = [];
  for (const el of $$('[data-odds]')) {
    const key = el.dataset.odds;
    const yes = Number(el.dataset.yes);
    const before = shownOdds.get(key);
    if (motion && before != null && Math.abs(before - yes) >= 0.005) {
      if (el.tagName === 'I') {
        el.style.transform = `scaleX(${before})`;
        bars.push([el, yes]);
      } else {
        el.classList.add('tick', yes > before ? 'up' : 'down');
      }
    }
  }
  for (const el of $$('[data-odds]')) shownOdds.set(el.dataset.odds, Number(el.dataset.yes));
  if (!bars.length) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const [el, yes] of bars) el.style.transform = `scaleX(${yes.toFixed(3)})`;
  }));
}

// New stories fade and rise in, a few at a time; ones already on screen stay put.
const shownStories = new Set();
function revealStories(container, { all = false } = {}) {
  let i = 0;
  for (const el of $$('.story[data-id]', container)) {
    const id = el.dataset.id;
    if ((all || (shownStories.size && !shownStories.has(id))) && i < 14 && !reducedMotion()) {
      el.classList.add('enter');
      el.style.setProperty('--i', i++);
    }
    shownStories.add(id);
  }
}

function oddsHtml(story, max = 2) {
  if (!story.markets?.length) return '';
  const mm = marketById();
  const rows = story.markets.slice(0, max).map(({ id }) => mm.get(id)).filter(Boolean).map((m) => {
    const o = m.outcomes[0];
    const label = m.binary ? m.title : `${m.title}: ${o.label}`;
    return `<div class="odd">
      <a href="${esc(m.url)}" target="_blank" rel="noopener" title="Open on Polymarket">${esc(label)}</a>
      <span>${pctHtml(m, o)}${changeHtml(o.change24h)}</span>
      ${barHtml(m, o)}
    </div>`;
  });
  return rows.length ? `<div class="odds" aria-label="Related Polymarket odds">${rows.join('')}</div>` : '';
}

function changeHtml(c) {
  if (!c || Math.abs(c) < 0.005) return '';
  const pts = Math.round(c * 100);
  return `<span class="chg ${pts > 0 ? 'up' : 'down'}" title="Change in the last 24 hours">${pts > 0 ? '+' : '−'}${Math.abs(pts)} today</span>`;
}

function sourceBadge(story) {
  const l = story.lead;
  const h = l.platform === 'web' ? l.sourceHost || l.host : PLATFORM_HOST[l.platform] || l.host;
  const img = l.avatar && (l.platform === 'x' || l.platform === 'bluesky') ? l.avatar : fav(h);
  return `<span class="src"><img src="${esc(img)}" alt="" loading="lazy" width="16" height="16">${esc(l.source)}</span>`;
}

function coverageHtml(story) {
  const others = story.sources.length - 1;
  if (others < 1) return '';
  const faces = story.sources.slice(1, 5).map((s) => {
    const h = s.platform === 'web' ? s.host || host(s.url) : PLATFORM_HOST[s.platform];
    return `<img src="${esc(s.avatar || fav(h))}" alt="" loading="lazy" width="18" height="18">`;
  }).join('');
  const open = state.open.has(story.id);
  return `<span class="faces" aria-hidden="true">${faces}</span><button class="coverage" type="button" data-toggle="${esc(story.id)}" aria-expanded="${open}">${others} more ${others === 1 ? 'source' : 'sources'}</button>`;
}

function sourcesListHtml(story) {
  if (!state.open.has(story.id)) return '';
  return coverageList(story.sources);
}

function coverageList(sources) {
  return `<ul class="sources-list">${sources.map((s) => {
    const h = s.platform === 'web' ? s.host || host(s.url) : PLATFORM_HOST[s.platform];
    return `<li><img class="fav" src="${esc(s.avatar || fav(h))}" alt="" loading="lazy" width="16" height="16">
      <a href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.name)}</b>${s.text ? `<q>${esc(s.text)}</q>` : ''}</a>
      ${s.publishedAt ? time(s.publishedAt) : '<span></span>'}</li>`;
  }).join('')}</ul>`;
}

function engagementHtml(story) {
  let pts = 0, cm = 0;
  for (const s of story.sources) { pts += s.engagement?.score || 0; cm += s.engagement?.comments || 0; }
  const parts = [];
  if (pts >= 50) parts.push(`<span class="num" title="Upvotes and likes across sources">${compact(pts)} points</span>`);
  if (cm >= 10) parts.push(`<span class="num">${compact(cm)} comments</span>`);
  return parts.join('');
}

// "First: @handle · 25m ahead": who published before every other source.
const leadText = (m) => (m < 60 ? `${m}m` : `${Math.round(m / 60)}h`);
function firstHtml(s) {
  const f = s.first;
  if (!f || f.leadMin < 10) return '';
  return `<span class="first-badge" title="${esc(`${f.name} published ${leadText(f.leadMin)} before ${f.next}, the next source`)}"><i aria-hidden="true"></i>First: <b>${esc(f.name)}</b> · ${leadText(f.leadMin)} ahead</span>`;
}

function storyHtml(s, { showThumb = true, dek = true } = {}) {
  const read = state.read.has(s.id) ? ' read' : '';
  const thumb = showThumb && s.image ? `<img class="thumb" src="${esc(s.image)}" alt="" loading="lazy" data-fallback="remove">` : '';
  const hot = s.sources.length >= 4 ? `<span class="hot">Developing</span>` : '';
  return `<article class="story${read}${thumb ? ' has-thumb' : ''}" data-id="${esc(s.id)}">
    <h3><a href="${esc(s.url)}" target="_blank" rel="noopener" data-read="${esc(s.id)}">${highlight(s.title)}</a></h3>
    ${dek && s.summary && s.summary !== s.title && !isUrlOnly(s.summary) ? `<p class="dek">${highlight(s.summary)}</p>` : ''}
    ${thumb}
    <div class="meta">${hot}${sourceBadge(s)}${time(s.publishedAt)}${firstHtml(s)}${coverageHtml(s)}${engagementHtml(s)}${s.topics.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${sourcesListHtml(s)}
    ${oddsHtml(s)}
  </article>`;
}

// ---------- News view ----------

const KINDS = [
  ['all', 'All sources'],
  ['lab', 'Labs'],
  ['press', 'Press'],
  ['social', 'X and Bluesky'],
  ['reddit', 'Reddit'],
  ['hn', 'Hacker News'],
  ['analysis', 'Newsletters'],
  ['markets', 'With odds'],
];

function matchesKind(s, k) {
  if (k === 'all') return true;
  if (k === 'markets') return s.markets?.length > 0;
  if (k === 'reddit' || k === 'hn') return s.sources.some((x) => x.platform === k);
  if (k === 'social') return s.sources.some((x) => x.platform === 'x' || x.platform === 'bluesky');
  return s.sources.some((x) => x.kind === k);
}

function matchesQuery(text) {
  return !state.q || text.toLowerCase().includes(state.q.toLowerCase());
}

function filteredStories() {
  return state.data.stories.filter((s) =>
    (state.topic === 'All' || s.topics.includes(state.topic)) &&
    (!state.entity || s.entities.includes(state.entity)) &&
    matchesKind(s, state.kind) &&
    matchesQuery(`${s.title} ${s.summary} ${s.sources.map((x) => x.name).join(' ')}`));
}

function renderChips() {
  const stories = state.data.stories;
  const counts = {};
  for (const s of stories) for (const t of s.topics) counts[t] = (counts[t] || 0) + 1;
  const topics = ['All', ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])];
  setHtml($('#topicChips'), topics.map((t) =>
    `<button class="chip" type="button" data-topic="${esc(t)}" aria-pressed="${state.topic === t}">${esc(t)}${t !== 'All' ? `<span class="n">${counts[t]}</span>` : ''}</button>`).join(''));
  setHtml($('#sortSeg'), [['top', 'Top'], ['latest', 'Latest']].map(([k, l]) => `<button type="button" data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join(''));
  setHtml($('#kindChips'), KINDS.map(([k, l]) => `<button class="chip" type="button" data-kind="${k}" aria-pressed="${state.kind === k}">${l}</button>`).join(''));
}

function pickLead(stories) {
  const recent = stories.filter((s) => Date.now() - s.publishedAt < 18 * 3600e3);
  const pool = recent.length ? recent : stories;
  return pool.slice().sort((a, b) => b.score * (1 + 0.25 * Math.min(4, b.sources.length - 1)) - a.score * (1 + 0.25 * Math.min(4, a.sources.length - 1)))[0];
}

function renderLead(lead, rising) {
  if (!lead) return (setHtml($('#lead'), ''));
  const img = lead.image ? `<a class="lead-img" href="${esc(lead.url)}" target="_blank" rel="noopener" tabindex="-1"><img src="${esc(lead.image)}" alt="" data-fallback="remove-parent"></a>` : '';
  setHtml($('#lead'), `
    <article class="lead story" data-id="${esc(lead.id)}">
      ${img}
      <div class="lead-meta">${lead.sources.length >= 3 ? '<span class="hot">Developing</span>' : ''}${sourceBadge(lead)}${time(lead.publishedAt)}${coverageHtml(lead)}${engagementHtml(lead)}</div>
      <h1><a href="${esc(lead.url)}" target="_blank" rel="noopener" data-read="${esc(lead.id)}">${esc(lead.title)}</a></h1>
      ${lead.summary && !isUrlOnly(lead.summary) ? `<p class="dek">${esc(lead.summary)}</p>` : ''}
      ${oddsHtml(lead)}
      ${lead.sources.length > 1 ? `<div class="lead-coverage"><h2>Who's covering it</h2>${coverageList(lead.sources.slice(0, 7))}</div>` : ''}
    </article>
    <div class="rising">
      <h2>Also leading right now</h2>
      ${rising.map((s) => storyHtml(s, { showThumb: false, dek: false })).join('')}
    </div>`);
}

function bucket(ts) {
  const h = (Date.now() - ts) / 3600e3;
  if (h < 1) return 'Past hour';
  if (h < 3) return 'Past 3 hours';
  if (h < 8) return 'Earlier today';
  if (h < 24) return 'Past 24 hours';
  if (h < 48) return 'Yesterday';
  return 'Older';
}

// ---------- Trending ----------

const TREND_WINDOWS = [[3, '3h'], [6, '6h'], [24, '24h']];

function trendData() {
  if (state.trendHours !== 6 && state.trend?.hours === state.trendHours && state.trend.version === state.data.version) return state.trend;
  return state.data.trending;
}

// The non-default windows come from /api/trending; the 6-hour one ships in the snapshot.
async function loadTrend({ animate = true } = {}) {
  if (state.trendHours === 6 || state.mode !== 'api') return renderTrending({ animate });
  try {
    const res = await fetch(`api/trending?hours=${state.trendHours}`);
    if (res.ok) state.trend = await res.json();
  } catch { /* keep the snapshot's */ }
  if (state.view === 'news') renderTrending({ animate });
}

function sparkSvg(values) {
  const max = Math.max(1, ...values);
  const step = 64 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(17 - (v / max) * 15).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 64 18" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="M0,18 L${pts.join(' L')} L64,18 Z"/><polyline points="${pts.join(' ')}"/></svg>`;
}

let trendKeys = '';
function renderTrending({ animate = false } = {}) {
  const t = trendData();
  const box = $('#trending');
  const topics = t?.topics || [];
  box.hidden = !topics.length;
  if (!topics.length) return;
  $('#trendNote').textContent = `Most coverage versus the usual pace, last ${t.hours} hours`;
  setHtml($('#trendWindow'), state.mode === 'api'
    ? TREND_WINDOWS.map(([h, l]) => `<button class="chip" type="button" data-trend-hours="${h}" aria-pressed="${state.trendHours === h}">${l}</button>`).join('')
    : '');
  const keys = topics.map((x) => x.key).join();
  const list = $('#trendList');
  list.classList.toggle('animate', (animate || keys !== trendKeys) && !reducedMotion());
  trendKeys = keys;
  list.innerHTML = topics.map((x, i) => `<li style="--i:${i}">
    <button class="trend" type="button" data-entity="${esc(x.key)}" aria-pressed="${state.entity === x.key}" title="${x.count} stories from ${x.sources} sources, ${x.lift}× the usual rate. Click to filter.">
      <span class="t-rank">${i + 1}</span>
      <span class="t-name">${esc(x.label)}</span>
      ${sparkSvg(x.spark)}
      <span class="t-meta"><b>${x.count}</b> ${x.count === 1 ? 'story' : 'stories'}${x.lift >= 1.5 ? ` <span class="t-lift">${x.lift >= 10 ? Math.round(x.lift) : x.lift.toFixed(1)}×</span>` : ''}</span>
    </button></li>`).join('');
}

function renderNews({ animate = false } = {}) {
  renderTrending();
  renderChips();
  const all = filteredStories();
  const filtered = state.topic !== 'All' || state.kind !== 'all' || state.q || state.entity;
  let rest = all;
  if (!filtered && state.sort === 'top') {
    const lead = pickLead(all);
    const rising = all.filter((s) => s !== lead).slice(0, 3);
    renderLead(lead, rising);
    const skip = new Set([lead, ...rising].map((s) => s?.id));
    rest = all.filter((s) => !skip.has(s.id));
  } else {
    setHtml($('#lead'), '');
  }

  if (state.sort === 'latest') rest = rest.slice().sort((a, b) => b.publishedAt - a.publishedAt);
  const shown = rest.slice(0, state.limit);
  let html = '';
  if (!shown.length) {
    html = `<p class="empty">${state.q ? `Nothing matches "${esc(state.q)}". Try a company or model name.` : 'No stories match these filters. Choose All to see everything.'}</p>`;
  } else if (state.sort === 'latest') {
    let last = null;
    for (const s of shown) {
      const b = bucket(s.publishedAt);
      if (b !== last) { html += `<h2 class="when">${b}</h2>`; last = b; }
      html += storyHtml(s);
    }
  } else {
    html = shown.map((s) => storyHtml(s)).join('');
  }
  if (state.entity) {
    const label = trendData()?.topics.find((x) => x.key === state.entity)?.label || state.entity;
    html = `<p class="entity-bar">Stories about <b>${esc(label)}</b> <button class="chip" type="button" data-entity="${esc(state.entity)}">Show all stories</button></p>` + html;
  }
  setHtml($('#river'), html);
  revealStories($('#river'), { all: animate });
  revealStories($('#lead'), { all: animate });
  const more = $('#moreStories');
  more.hidden = rest.length <= state.limit;
  more.textContent = `Show more stories (${rest.length - state.limit} left)`;
  renderRail();
}

function renderRail() {
  const { markets, social } = state.data;
  const heat = (m) => m.move * Math.log10(10 + m.volume24h);
  const moving = markets.filter((m) => m.volume24h > 1000).slice().sort((a, b) => heat(b) - heat(a)).slice(0, 6);
  setHtml($('#railMarkets'), moving.map((m) => {
    const o = m.outcomes.slice().sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0))[0];
    const label = m.binary ? m.title : `${m.title}: ${o.label}`;
    return `<li><a class="q" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(label)}</a>
      ${barHtml(m, o)}
      <span class="row"><span>${pctHtml(m, o, 'b', 'num')} ${changeHtml(o.change24h)}</span><span class="num">$${compact(m.volume24h)} today</span></span></li>`;
  }).join('') || '<li class="rail-note">Markets are loading.</li>');

  const posts = social.filter((p) => matchesQuery(`${p.title} ${p.author}`)).slice(0, 14);
  setHtml($('#railPosts'), posts.map((p) => `<li><a class="post" href="${esc(p.url)}" target="_blank" rel="noopener">
      <img class="av" src="${esc(p.avatar || fav(PLATFORM_HOST[p.platform]))}" alt="" loading="lazy" width="30" height="30">
      <span><span class="who"><b>${esc(p.author)}</b>${p.platform === 'x' ? `@${esc(p.handle)}` : 'Bluesky'} ${time(p.publishedAt)}</span><p>${highlight(p.title)}</p></span>
    </a></li>`).join('') || '<li class="rail-note">No posts yet. X posts appear once an X source is configured; see the Sources list at the bottom of the page.</li>');

  const releases = (state.data.releases || []).filter((r) => r.notable).slice(0, 6);
  setHtml($('#railModels'), releases.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">
      <img src="${esc(releaseLogo(r))}" alt="" width="18" height="18" loading="lazy">
      <span><b>${esc(r.name)}</b><span>${esc(r.provider)} · ${shortDate(r.date)}</span></span></a></li>`).join('') || '<li class="rail-note">Releases are loading.</li>');
}

// ---------- Releases view ----------
// Models launched in the last 90 days (server: src/sources/releases.js).

const LAB_SITES = {
  anthropic: 'anthropic.com', openai: 'openai.com', google: 'gemini.google.com', 'x-ai': 'x.ai', 'xai-org': 'x.ai', meta: 'meta.ai',
  'meta-llama': 'meta.ai', mistralai: 'mistral.ai', deepseek: 'deepseek.com', 'deepseek-ai': 'deepseek.com', qwen: 'qwen.ai',
  moonshotai: 'moonshot.ai', 'z-ai': 'z.ai', 'zai-org': 'z.ai', minimax: 'minimax.io', minimaxai: 'minimax.io', nvidia: 'nvidia.com',
  microsoft: 'microsoft.com', amazon: 'aws.amazon.com', cohere: 'cohere.com', coherelabs: 'cohere.com', ai21: 'ai21.com',
  perplexity: 'perplexity.ai', 'ibm-granite': 'ibm.com', liquid: 'liquid.ai', liquidai: 'liquid.ai', allenai: 'allenai.org',
  tencent: 'tencent.com', baidu: 'baidu.com', bytedance: 'bytedance.com', 'bytedance-seed': 'bytedance.com',
  'black-forest-labs': 'bfl.ai', stabilityai: 'stability.ai', apple: 'apple.com', inception: 'inceptionlabs.ai', 'wan-ai': 'alibabacloud.com',
};
const releaseLogo = (r) => fav(LAB_SITES[r.org] || (r.api ? 'openrouter.ai' : 'huggingface.co'));
const shortDate = (ts) => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const REL_FILTERS = [
  ['notable', 'Major labs', (r) => r.notable],
  ['open', 'Open weights', (r) => r.open],
  ['api', 'API', (r) => r.api],
  ['all', 'Everything', () => true],
];
const fmtContext = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`) + ' context';
const fmtPrice = (r) => {
  if (r.priceIn == null) return '';
  if (!r.priceIn && !r.priceOut) return 'Free';
  const p = (x) => `$${x < 1 ? +x.toFixed(2) : +x.toFixed(1)}`;
  return `${p(r.priceIn)} in / ${p(r.priceOut)} out per M`;
};

function releaseBucket(ts) {
  const days = (Date.now() - ts) / 86400e3;
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  return new Date(ts).toLocaleDateString('en', { month: 'long', year: 'numeric' });
}

function releaseHtml(r) {
  const isNew = Date.now() - r.date < 2 * 86400e3;
  const meta = [
    r.api ? '<span class="badge badge-api">API</span>' : '',
    r.open ? `<a class="badge badge-open" href="https://huggingface.co/${esc(r.hf || '')}" target="_blank" rel="noopener">Open weights</a>` : '',
    r.context ? `<span>${fmtContext(r.context)}</span>` : '',
    fmtPrice(r) ? `<span>${fmtPrice(r)}</span>` : '',
    r.sizes?.length > 1 ? `<span>${r.sizes.length} sizes</span>` : '',
    r.story ? `<a class="rel-story" href="${esc(r.story.url)}" target="_blank" rel="noopener">In the news ↗</a>` : '',
  ].filter(Boolean).join('');
  return `<li class="rel" data-id="${esc(r.id)}">
    <img class="rel-logo" src="${esc(releaseLogo(r))}" alt="" width="32" height="32" loading="lazy">
    <div class="rel-main">
      <div class="rel-title"><a href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.summary || r.name)}">${highlight(r.name)}</a>${isNew ? '<span class="rel-new">New</span>' : ''}</div>
      <div class="rel-by">${esc(r.provider)}</div>
      <div class="rel-meta">${meta}</div>
    </div>
    <time class="rel-date" datetime="${new Date(r.date).toISOString()}">${shortDate(r.date)}</time>
  </li>`;
}

function renderReleases({ animate = false } = {}) {
  const all = (state.data.releases || []).filter((r) => matchesQuery(`${r.name} ${r.provider}`));
  setHtml($('#relChips'), REL_FILTERS.map(([k, l, f]) =>
    `<button class="chip" type="button" data-rel="${k}" aria-pressed="${state.relFilter === k}">${l}<span class="n">${all.filter(f).length}</span></button>`).join(''));
  const keep = (REL_FILTERS.find(([k]) => k === state.relFilter) || REL_FILTERS[0])[2];
  const groups = new Map();
  for (const r of all.filter(keep)) {
    const b = releaseBucket(r.date);
    groups.has(b) ? groups.get(b).push(r) : groups.set(b, [r]);
  }
  setHtml($('#relList'), [...groups].map(([b, list]) => `<section class="rel-group" data-id="${esc(b)}"><h2 class="when">${esc(b)}<span>${list.length}</span></h2><ol class="rel-list">${list.map(releaseHtml).join('')}</ol></section>`).join('') ||
    `<p class="empty">${state.data.releases?.length ? 'No releases match.' : 'Releases are loading.'}</p>`);
  if (animate && !reducedMotion()) $$('#relList .rel').slice(0, 18).forEach((el, i) => { el.classList.add('enter'); el.style.setProperty('--i', i); });
}

// ---------- Tech view ----------
// Non-AI technology stories, labelled by the server's topic classifier.

const TECH_TOPICS = ['General', 'Software', 'Security', 'Gadgets', 'Platforms', 'AI'];

function renderTech({ animate = false } = {}) {
  const all = state.data.tech || [];
  const counts = {};
  for (const s of all) counts[s.topic] = (counts[s.topic] || 0) + 1;
  const topics = ['All', ...TECH_TOPICS.filter((t) => counts[t])];
  if (!topics.includes(state.techTopic)) state.techTopic = 'All';
  $('#techChips').innerHTML =
    topics.map((t) => `<button class="chip" type="button" data-techtopic="${esc(t)}" aria-pressed="${state.techTopic === t}">${esc(t === 'AI' ? 'AI-adjacent' : t)}<span class="n">${t === 'All' ? all.length : counts[t]}</span></button>`).join('');
  setHtml($('#techSortSeg'), [['top', 'Top'], ['latest', 'Latest']].map(([k, l]) => `<button type="button" data-techsort="${k}" aria-pressed="${state.techSort === k}">${l}</button>`).join(''));

  let list = all.filter((s) => state.techTopic === 'All' || s.topic === state.techTopic).filter((s) => matchesQuery(`${s.title} ${s.summary || ''}`));
  if (state.techSort === 'latest') list = list.slice().sort((a, b) => b.publishedAt - a.publishedAt);
  const shown = list.slice(0, state.techLimit);
  setHtml($('#techRiver'), shown.map((s) => storyHtml(s).replace('class="story', `data-topic="${esc(s.topic)}" class="story`)).join('') ||
    `<p class="empty">${all.length ? 'No tech stories match.' : 'Tech stories appear after the first classified crawl (every 10 minutes).'}</p>`);
  revealStories($('#techRiver'), { all: animate });
  const more = $('#moreTech');
  more.hidden = list.length <= state.techLimit;
  more.textContent = `Show more (${list.length - state.techLimit} left)`;
}

// ---------- X view ----------
// Posts come from /api/x (every X post we hold, filterable and paged). On a
// static build it falls back to the X posts in the snapshot.

const shownX = new Set();
const xKey = () => `${state.xCat}|${state.xHandle || ''}|${state.xq}`;

function linkifyPost(text) {
  return highlight(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 42)}${u.length > 50 ? '…' : ''}</a>`)
    .replace(/(^|[\s(])@(\w{1,15})/g, '$1<a href="https://x.com/$2" target="_blank" rel="noopener">@$2</a>');
}

function staticX() {
  const all = (state.data?.social || []).filter((p) => p.platform === 'x');
  const q = state.xq.toLowerCase();
  const posts = all
    .filter((p) => (state.xCat === 'all' || (p.cats || []).includes(state.xCat)) && (!state.xHandle || p.handle === state.xHandle) && (!q || `${p.title} ${p.author}`.toLowerCase().includes(q)))
    .map((p) => ({ ...p, text: p.summary || p.title, likes: p.engagement?.score || 0, replies: p.engagement?.comments || 0 }));
  const accounts = new Map();
  for (const p of all) if (!accounts.has(p.handle)) accounts.set(p.handle, { handle: p.handle, name: p.author, avatar: p.avatar, group: p.group, latest: p.publishedAt, count: 0 });
  for (const p of all) accounts.get(p.handle).count++;
  const counts = {};
  for (const p of all) for (const c of p.cats || []) counts[c] = (counts[c] || 0) + 1;
  return {
    posts, nextBefore: null, accounts: [...accounts.values()],
    cats: [['all', 'All', all.length], ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => [c, c, n])],
    status: { ok: all.length > 0 },
  };
}

async function loadX({ append = false, animate = false } = {}) {
  const key = xKey();
  const version = state.data?.version;
  let next;
  if (state.mode === 'api') {
    const qs = new URLSearchParams({ cat: state.xCat, limit: '40' });
    if (state.xHandle) qs.set('handle', state.xHandle);
    if (state.xq) qs.set('q', state.xq);
    if (append && state.x?.nextBefore) qs.set('before', state.x.nextBefore);
    if (!state.x) setHtml($('#xFeed'), skeletonX());
    try {
      const res = await fetch(`api/x?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      next = await res.json();
    } catch {
      next = staticX();
    }
  } else next = staticX();
  if (key !== xKey()) return; // a newer filter won the race
  if (append && state.x) next = { ...next, posts: [...state.x.posts, ...next.posts] };
  else if (!animate && state.x?.key === key) {
    // A live refresh: keep anything already paged in below the fresh page.
    const seen = new Set(next.posts.map((p) => p.id));
    const oldest = next.posts.at(-1)?.publishedAt ?? Infinity;
    next.posts.push(...state.x.posts.filter((p) => !seen.has(p.id) && p.publishedAt < oldest));
  }
  state.x = { ...next, key, version };
  const draw = () => drawX({ animate });
  animate ? transition(draw) : draw();
}

function skeletonX() {
  return Array.from({ length: 6 }, () => `<li class="xpost skeleton-post" aria-hidden="true"><span class="av skeleton"></span><span><span class="skeleton w40"></span><span class="skeleton"></span><span class="skeleton w80"></span></span></li>`).join('');
}

// Leaderboard of first reporters (server: src/pipeline/scoops.js). X accounts
// filter the feed when clicked; outlets open their latest scoop.
let scoopsShown = '';
function renderScoops() {
  const board = state.data?.scoops || [];
  const max = Math.max(1, ...board.map((e) => e.firsts));
  setHtml($('#scoopList'), board.map((e, i) => {
    const isX = e.platform === 'x';
    const handle = isX ? e.name.replace(/^@/, '') : null;
    const logo = e.avatar || fav(isX ? 'x.com' : e.host);
    const best = e.stories[0];
    const name = isX
      ? `<button type="button" class="scoop-name" data-xhandle="${esc(handle)}">${esc(e.name)}</button>`
      : `<span class="scoop-name">${esc(e.name)}</span>`;
    return `<li data-id="${esc(e.name)}" style="--i:${i}">
      <span class="scoop-rank">${i + 1}</span>
      <img src="${esc(logo)}" alt="" width="28" height="28" loading="lazy">
      <div class="scoop-body">
        <div class="scoop-top">${name}<span class="scoop-n">${e.firsts} first${e.firsts === 1 ? '' : 's'}</span></div>
        <span class="scoop-bar" aria-hidden="true"><i style="transform:scaleX(${(e.firsts / max).toFixed(3)})"></i></span>
        <div class="scoop-meta">Usually ${leadText(e.medianLeadMin)} ahead${best ? ` · <span title="${esc(best.title)}">${esc(best.title.length > 48 ? `${best.title.slice(0, 46)}…` : best.title)}</span>` : ''}</div>
      </div>
    </li>`;
  }).join('') || '<li class="rail-note">No clear first reports yet.</li>');
  // Bars grow in the first time the board appears.
  const sig = board.map((e) => e.name).join('|');
  if (sig && sig !== scoopsShown && !reducedMotion()) $('#scoopList').classList.add('animate');
  scoopsShown = sig;
}

function renderX() {
  if (!state.x || state.x.version !== state.data?.version || state.x.key !== xKey()) loadX();
  else drawX();
}

function drawX({ animate = false } = {}) {
  const x = state.x;
  if (!x) return;
  setHtml($('#xGroups'), (x.cats || []).map(([k, l, n]) =>
    `<button class="chip" type="button" data-xcat="${esc(k)}" aria-pressed="${state.xCat === k}">${esc(l)}<span class="n">${compact(n)}</span></button>`).join(''));

  const hour = Date.now() - 3600e3;
  setHtml($('#xAccounts'), x.accounts.filter((a) => a.count).slice(0, 40).map((a) =>
    `<li><button type="button" class="x-acct${a.latest > hour ? ' hot' : ''}" data-xhandle="${esc(a.handle)}" aria-pressed="${state.xHandle === a.handle}" title="${esc(a.name || a.handle)} · ${a.count} posts">
      <span class="ring"><img src="${esc(a.avatar || fav('x.com'))}" alt="" loading="lazy" width="44" height="44"></span>
      <span class="h">@${esc(a.handle)}</span>
    </button></li>`).join(''));

  const st = x.status || {};
  setHtml($('#xStatus'), st.ok ? `<i class="dot on"></i>Live${st.lastRun ? ` · checked ${ago(st.lastRun)}` : ''}` : `<i class="dot"></i>${st.error ? 'X source is having trouble' : 'Waiting for X'}`);

  const fresh = [];
  setHtml($('#xFeed'), x.posts.map((p) => {
    const isNew = shownX.size && !shownX.has(p.id);
    if (animate || isNew) fresh.push(p.id);
    const link = p.linkUrl ? `<a class="x-link" href="${esc(p.linkUrl)}" target="_blank" rel="noopener"><img src="${esc(fav(host(p.linkUrl)))}" alt="" width="16" height="16" loading="lazy">${esc(host(p.linkUrl))}</a>` : '';
    return `<li class="xpost${isNew ? ' is-new' : ''}" data-id="${esc(p.id)}">
      <img class="av" src="${esc(p.avatar || fav('x.com'))}" alt="" loading="lazy" width="40" height="40">
      <div class="body">
        <div class="who"><b>${esc(p.author || p.handle)}</b><button type="button" class="handle" data-xhandle="${esc(p.handle)}">@${esc(p.handle)}</button>${p.cats?.[0] ? `<span class="tag tag-${esc(p.cats[0].toLowerCase())}">${esc(p.cats[0])}</span>` : ''}<a class="when" href="${esc(p.url)}" target="_blank" rel="noopener">${time(p.publishedAt)}</a></div>
        <p>${linkifyPost(p.text || '')}</p>
        ${p.image ? `<a class="x-img" href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.image)}" alt="" loading="lazy"></a>` : ''}
        <div class="x-foot">${link}${p.likes ? `<span class="num">♥ ${compact(p.likes)}</span>` : ''}${p.replies ? `<span class="num">${compact(p.replies)} replies</span>` : ''}<a class="open" href="${esc(p.url)}" target="_blank" rel="noopener">Open on X ↗</a></div>
      </div>
    </li>`;
  }).join('') || `<li class="empty">${state.xq || state.xHandle ? 'No posts match.' : 'No X posts yet. They appear once the X source has run; see Sources at the bottom of the page.'}</li>`);

  if (!reducedMotion()) {
    let i = 0;
    for (const id of fresh.slice(0, 16)) {
      const el = $(`.xpost[data-id="${CSS.escape(id)}"]`, $('#xFeed'));
      if (!el) continue;
      el.classList.add('enter');
      el.style.setProperty('--i', i++);
    }
  }
  for (const p of x.posts) shownX.add(p.id);
  renderScoops();
  $('#moreX').hidden = !x.nextBefore;
}

// ---------- Builds view ----------

const BUILD_FILTERS = [
  ['all', 'Everything'],
  ['hn', 'Show HN'],
  ['reddit', 'Reddit'],
  ['github', 'GitHub'],
  ['huggingface', 'Hugging Face demos'],
  ['producthunt', 'Product Hunt'],
];

function buildStats(b) {
  const e = b.engagement || {};
  const out = [];
  if (b.platform === 'github') out.push(e.starsToday ? `${compact(e.starsToday)} stars today` : `${compact(e.score)} stars`);
  else if (b.platform === 'huggingface') out.push(`${compact(e.score)} likes`);
  else if (e.score) out.push(`${compact(e.score)} points`);
  if (e.comments) out.push(b.discussionUrl ? `<a href="${esc(b.discussionUrl)}" target="_blank" rel="noopener">${compact(e.comments)} comments</a>` : `${compact(e.comments)} comments`);
  out.push(time(b.publishedAt));
  return out.map((x) => `<span>${x}</span>`).join('');
}

function renderBuilds() {
  const counts = {};
  for (const b of state.data.builds) counts[b.platform] = (counts[b.platform] || 0) + 1;
  setHtml($('#buildChips'), BUILD_FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, l]) =>
    `<button class="chip" type="button" data-build="${k}" aria-pressed="${state.buildFilter === k}">${l}${k !== 'all' ? `<span class="n">${counts[k]}</span>` : ''}</button>`).join(''));
  let list = state.data.builds.filter((b) => (state.buildFilter === 'all' || b.platform === state.buildFilter) && matchesQuery(`${b.title} ${b.summary} ${b.author}`));
  if (state.buildFilter === 'all') list = interleave(list);
  setHtml($('#buildGrid'), list.map((b, i) => {
    const h = PLATFORM_HOST[b.platform] || host(b.url);
    const glyph = b.emoji ? esc(b.emoji) : `<img src="${esc(b.avatar || fav(b.platform === 'hn' || b.platform === 'producthunt' ? host(b.url) || h : h))}" alt="" loading="lazy">`;
    const feature = i < 2 && state.buildFilter === 'all' && !state.q ? ' feature' : '';
    return `<article class="build${feature}">
      <div class="top"><span class="glyph">${glyph}</span><span class="by"><b>${esc(b.source)}</b>${b.author ? `by ${esc(b.author)}` : ''}</span></div>
      <div><h3><a href="${esc(b.url)}" target="_blank" rel="noopener">${highlight(b.title)}</a></h3>${b.summary ? `<p>${highlight(b.summary)}</p>` : ''}</div>
      <div class="stats">${buildStats(b)}</div>
    </article>`;
  }).join('') || `<p class="empty">No projects match. Clear the search or choose Everything.</p>`);
}

// Round-robin across platforms, keeping each platform's own ranking.
function interleave(list) {
  const lanes = new Map();
  for (const b of list) {
    if (!lanes.has(b.platform)) lanes.set(b.platform, []);
    lanes.get(b.platform).push(b);
  }
  const order = [...lanes.values()].sort((a, b) => b[0].score - a[0].score);
  const out = [];
  for (let i = 0; out.length < list.length; i++) for (const lane of order) if (lane[i]) out.push(lane[i]);
  return out;
}

// ---------- Markets view ----------

function renderMarkets() {
  const sorts = [['moving', 'Moving most'], ['volume', 'Most traded today'], ['linked', 'In the news'], ['ending', 'Ending soonest']];
  setHtml($('#marketSort'), sorts.map(([k, l]) => `<button class="chip" type="button" data-msort="${k}" aria-pressed="${state.marketSort === k}">${l}</button>`).join(''));
  let list = state.data.markets.filter((m) => matchesQuery(`${m.title} ${m.outcomes.map((o) => o.label).join(' ')}`));
  if (state.marketSort === 'moving') list = list.filter((m) => m.volume24h > 200).sort((a, b) => b.move - a.move);
  if (state.marketSort === 'volume') list.sort((a, b) => b.volume24h - a.volume24h);
  if (state.marketSort === 'linked') list = list.filter((m) => m.stories.length).sort((a, b) => b.stories.length - a.stories.length || b.volume24h - a.volume24h);
  if (state.marketSort === 'ending') list = list.filter((m) => m.endDate && Date.parse(m.endDate) > Date.now()).sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate));
  const storyById = new Map(state.data.stories.map((s) => [s.id, s]));
  setHtml($('#marketList'), list.slice(0, 90).map((m) => `
    <article class="market">
      <header>${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : '<span></span>'}
        <div><h3><a href="${esc(m.url)}" target="_blank" rel="noopener">${highlight(m.title)}</a></h3>
        <span class="vol num">$${compact(m.volume24h)} traded today, $${compact(m.volume)} total${m.endDate ? `, ends ${new Date(m.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</span></div>
      </header>
      <div class="outs">${m.outcomes.slice(0, 4).map((o) => `<div class="odd">
        <span class="odd-label">${esc(m.binary ? 'Yes' : o.label)}</span>
        <span>${pctHtml(m, o)}${changeHtml(o.change24h)}</span>
        ${barHtml(m, o)}</div>`).join('')}</div>
      ${m.stories.length ? `<div class="related"><span>In the news</span>${m.stories.map((r) => {
        const s = storyById.get(r.id);
        return `<a href="${esc(s?.url || '#news')}" target="_blank" rel="noopener">${esc(r.title)}</a>`;
      }).join('')}</div>` : ''}
    </article>`).join('') || `<p class="empty">No markets match. Clear the search to see all AI markets.</p>`);
}

// ---------- Footer ----------

const SOURCE_LABELS = { x: 'X', polymarket: 'Polymarket', hackernews: 'Hacker News', reddit: 'Reddit', bluesky: 'Bluesky', googlenews: 'Google News', rss: 'Lab blogs, press and newsletters', scraped: 'Lab news pages', openrouter: 'OpenRouter models', huggingface: 'Hugging Face', github: 'GitHub', producthunt: 'Product Hunt', showhn: 'Show HN', tech: 'Tech (classified)' };

function renderFoot() {
  const st = state.data.status || {};
  const src = st.sources || {};
  const ok = Object.values(src).filter((s) => s.ok).length;
  $('#footStatus').textContent = `${state.data.stories.length} stories, ${state.data.builds.length} projects and ${state.data.markets.length} markets from ${ok} of ${Object.keys(src).length} live sources. Rebuilt ${ago(state.data.generatedAt)}.`;
  $('#sourceTable').innerHTML = `<table>${Object.entries(src).map(([k, s]) => `<tr>
    <td>${esc(SOURCE_LABELS[k] || k)}${s.strategy ? ` (via ${esc(s.strategy)})` : ''}${s.accountsTotal ? `, ${s.accountsCached} of ${s.accountsTotal} accounts` : ''}</td>
    <td class="${s.ok ? 'ok' : 'bad'}">${s.ok ? `${s.count} items` : 'unavailable'}</td>
    <td>${s.lastRun ? ago(s.lastRun) : ''}</td>
    <td>${!s.ok && s.error ? esc(hint(k, s.error)) : ''}</td></tr>`).join('')}</table>`;
}

function hint(k, err) {
  if (k === 'x') return /rate limited/.test(err) ? `X embed timelines are rate limiting this server. ${err.match(/retrying in \d+ min/)?.[0] || 'Retrying soon'}.` : 'X embed timelines returned nothing. Setting X_BEARER_TOKEN, RSSHUB_URL or NITTER_INSTANCES gives a steadier feed.';
  if (k === 'reddit') return 'Reddit blocks this server. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.';
  if (k === 'github') return 'GitHub rate-limited this server. Set GITHUB_TOKEN.';
  return err.slice(0, 120);
}

// ---------- Render + routing ----------

// Site settings from the admin dashboard: name, tagline, banner, sections.
function applySite(site) {
  if (!site) return;
  $('#siteName').textContent = site.name;
  $('.wordmark').setAttribute('aria-label', `${site.name} home`);
  const tag = $('#tagline');
  tag.textContent = site.tagline || '';
  tag.hidden = !site.tagline;
  const b = $('#banner');
  b.hidden = !site.banner;
  b.replaceChildren();
  if (site.banner) {
    if (site.bannerLink) {
      const a = document.createElement('a');
      a.href = site.bannerLink;
      a.rel = 'noopener';
      a.textContent = site.banner;
      b.append(a);
    } else b.textContent = site.banner;
  }
  $('.tabs a[data-view="builds"]').hidden = !site.showBuilds;
  $('.tabs a[data-view="markets"]').hidden = !site.showMarkets;
  $('.rail-block:first-child').hidden = !site.showMarkets;
  state.sections = { builds: site.showBuilds, markets: site.showMarkets };
}

function render() {
  applySite(state.data?.site);
  if ((state.view === 'builds' && state.sections?.builds === false) || (state.view === 'markets' && state.sections?.markets === false)) state.view = 'news';
  for (const v of $$('.view')) v.hidden = v.dataset.view !== state.view;
  $$('.tabs a').forEach((a) => (a.dataset.view === state.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (!state.data) return;
  if (state.view === 'news') renderNews();
  if (state.view === 'x') renderX();
  if (state.view === 'tech') renderTech();
  if (state.view === 'releases') renderReleases();
  if (state.view === 'builds') renderBuilds();
  if (state.view === 'markets') renderMarkets();
  renderFoot();
  updateLive();
  animateOdds();
  $('#newPill').hidden = !state.pending;
}

function route() {
  if (state.mode === 'api' && /^#(search|doc\/)/.test(location.hash)) {
    state.view = searchUi.route(location.hash);
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  const v = location.hash.replace('#', '');
  state.view = ['news', 'x', 'tech', 'releases', 'builds', 'markets'].includes(v) ? v : 'news';
  const name = state.data?.site?.name || 'Frontier Wire';
  document.title = { news: name, x: `On X · ${name}`, tech: `Tech · ${name}`, releases: `AI releases · ${name}`, builds: `Built with AI · ${name}`, markets: `AI markets · ${name}` }[state.view];
  const changed = $(`.view[data-view="${state.view}"]`)?.hidden;
  const go = () => {
    render();
    window.scrollTo({ top: 0 });
  };
  changed && state.data ? transition(go) : go();
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  if (d.entity) {
    state.entity = state.entity === d.entity ? null : d.entity;
    state.limit = 60;
    transition(() => { renderNews({ animate: true }); animateOdds(); });
    if (state.entity) $('#trending').scrollIntoView({ block: 'nearest' });
  }
  else if (d.trendHours) { state.trendHours = Number(d.trendHours); loadTrend(); }
  else if (d.topic) { state.topic = d.topic; store.set('fw.topic', d.topic); state.limit = 60; renderNews({ animate: true }); animateOdds(); }
  else if (d.kind) { state.kind = d.kind; store.set('fw.kind', d.kind); state.limit = 60; renderNews(); }
  else if (d.sort) { state.sort = d.sort; store.set('fw.sort', d.sort); renderNews(); }
  else if (d.build) { state.buildFilter = d.build; store.set('fw.build', d.build); renderBuilds(); }
  else if (d.rel) { state.relFilter = d.rel; store.set('fw.relfilter', d.rel); transition(() => renderReleases({ animate: true })); }
  else if (d.techtopic) { state.techTopic = d.techtopic; state.techLimit = 40; store.set('fw.techtopic', d.techtopic); transition(() => renderTech({ animate: true })); }
  else if (d.techsort) { state.techSort = d.techsort; store.set('fw.techsort', d.techsort); transition(() => renderTech({ animate: true })); }
  else if (d.xcat) { state.xCat = d.xcat; state.xHandle = null; store.set('fw.xcat', d.xcat); loadX({ animate: true }); }
  else if (d.xhandle) { state.xHandle = state.xHandle === d.xhandle ? null : d.xhandle; loadX({ animate: true }); }
  else if (d.msort) { state.marketSort = d.msort; store.set('fw.msort', d.msort); renderMarkets(); }
  else if (d.toggle) {
    state.open.has(d.toggle) ? state.open.delete(d.toggle) : state.open.add(d.toggle);
    renderNews();
    $(`[data-toggle="${CSS.escape(d.toggle)}"]`)?.focus();
  } else if (d.read) {
    state.read.add(d.read);
    store.set('fw.read', [...state.read].slice(-800));
    t.closest('.story')?.classList.add('read');
  }
});

$('#moreStories').addEventListener('click', () => { state.limit += 60; renderNews(); });
$('#moreX').addEventListener('click', () => loadX({ append: true }));
$('#moreTech').addEventListener('click', () => { state.techLimit += 40; renderTech(); });
let xqTimer;
$('#xq').addEventListener('input', (e) => {
  clearTimeout(xqTimer);
  xqTimer = setTimeout(() => { state.xq = e.target.value.trim(); loadX({ animate: true }); }, 220);
});

$('#newPill').addEventListener('click', () => {
  if (state.pending) state.data = state.pending;
  state.pending = null;
  render();
  window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
});

let qTimer;
$('#q').addEventListener('input', (e) => {
  // With the server, the box is a search engine (see search.js); statically
  // hosted, it filters what's on screen.
  if (state.mode !== 'static') return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.limit = 60; render(); }, 120);
});

document.addEventListener('keydown', (e) => {
  const typing = /input|textarea/i.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape' && typing) { if (state.mode === 'static') { $('#q').value = ''; state.q = ''; render(); } $('#q').blur(); return; }
  if (typing || state.view !== 'news') return;
  if (e.key === 'j' || e.key === 'k') {
    const links = $$('.story h3 a, .lead h1 a');
    const i = links.indexOf(document.activeElement);
    const next = links[e.key === 'j' ? Math.min(links.length - 1, i + 1) : Math.max(0, i - 1)];
    next?.focus();
    next?.closest('.story')?.scrollIntoView({ block: 'center' });
  }
});

// Theme: follows the system unless the reader picks one.
const savedTheme = store.get('fw.theme', null);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('fw.theme', next);
});

window.addEventListener('hashchange', route);
window.addEventListener('scroll', () => {
  if (state.pending && window.scrollY < 120 && state.view === 'news') {
    state.data = state.pending;
    state.pending = null;
    render();
  }
}, { passive: true });

setInterval(() => {
  for (const t of $$('time[data-ts]')) t.textContent = ago(+t.dataset.ts);
  updateLive();
}, 30e3);

// Images that fail to load are removed instead of showing a broken icon.
// (Delegated listener: inline onerror handlers are blocked by the CSP.)
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el.tagName !== 'IMG' || !el.dataset.fallback) return;
  if (el.dataset.fallback === 'remove-parent') el.parentNode?.remove();
  else el.remove();
}, true);
$('#searchForm').addEventListener('submit', (e) => e.preventDefault());

// Boot
searchUi = createSearch({ esc, ago, time, fav, pct, compact });
async function updateSpiderLine() {
  if (state.mode !== 'api') return;
  $('#footSpider').textContent = await spiderLine(compact);
}
setInterval(() => !document.hidden && updateSpiderLine(), 30e3);
setHtml($('#river'), Array.from({ length: 6 }, () => '<div class="skeleton-card" aria-hidden="true"><i class="skeleton"></i><i class="skeleton w80"></i><i class="skeleton w40"></i></div>').join(''));
route();
await refresh();
updateSpiderLine();
connect();
