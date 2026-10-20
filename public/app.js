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
    if (!state.data) $('#river').innerHTML = `<p class="empty">Couldn't load the feed. ${esc(e.message)}. Check that the server is running, then reload.</p>`;
  }
}

function connect() {
  if (state.mode === 'static' || !window.EventSource) {
    setInterval(refresh, 60e3);
    return;
  }
  const es = new EventSource('api/stream');
  es.addEventListener('update', () => refresh());
  es.addEventListener('hello', () => setLive('on'));
  es.onerror = () => {
    setLive('off');
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
}

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

function storyHtml(s, { showThumb = true, dek = true } = {}) {
  const read = state.read.has(s.id) ? ' read' : '';
  const thumb = showThumb && s.image ? `<img class="thumb" src="${esc(s.image)}" alt="" loading="lazy" data-fallback="remove">` : '';
  const hot = s.sources.length >= 4 ? `<span class="hot">Developing</span>` : '';
  return `<article class="story${read}${thumb ? ' has-thumb' : ''}" data-id="${esc(s.id)}">
    <h3><a href="${esc(s.url)}" target="_blank" rel="noopener" data-read="${esc(s.id)}">${highlight(s.title)}</a></h3>
    ${dek && s.summary && s.summary !== s.title && !isUrlOnly(s.summary) ? `<p class="dek">${highlight(s.summary)}</p>` : ''}
    ${thumb}
    <div class="meta">${hot}${sourceBadge(s)}${time(s.publishedAt)}${coverageHtml(s)}${engagementHtml(s)}${s.topics.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
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
  $('#topicChips').innerHTML = topics.map((t) =>
    `<button class="chip" type="button" data-topic="${esc(t)}" aria-pressed="${state.topic === t}">${esc(t)}${t !== 'All' ? `<span class="n">${counts[t]}</span>` : ''}</button>`).join('');
  $('#sortSeg').innerHTML = [['top', 'Top'], ['latest', 'Latest']].map(([k, l]) => `<button type="button" data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join('');
  $('#kindChips').innerHTML = KINDS.map(([k, l]) => `<button class="chip" type="button" data-kind="${k}" aria-pressed="${state.kind === k}">${l}</button>`).join('');
}

function pickLead(stories) {
  const recent = stories.filter((s) => Date.now() - s.publishedAt < 18 * 3600e3);
  const pool = recent.length ? recent : stories;
  return pool.slice().sort((a, b) => b.score * (1 + 0.25 * Math.min(4, b.sources.length - 1)) - a.score * (1 + 0.25 * Math.min(4, a.sources.length - 1)))[0];
}

function renderLead(lead, rising) {
  if (!lead) return ($('#lead').innerHTML = '');
  const img = lead.image ? `<a class="lead-img" href="${esc(lead.url)}" target="_blank" rel="noopener" tabindex="-1"><img src="${esc(lead.image)}" alt="" data-fallback="remove-parent"></a>` : '';
  $('#lead').innerHTML = `
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
    </div>`;
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
  $('#trendWindow').innerHTML = state.mode === 'api'
    ? TREND_WINDOWS.map(([h, l]) => `<button class="chip" type="button" data-trend-hours="${h}" aria-pressed="${state.trendHours === h}">${l}</button>`).join('')
    : '';
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
    $('#lead').innerHTML = '';
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
  $('#river').innerHTML = html;
  revealStories($('#river'), { all: animate });
  revealStories($('#lead'), { all: animate });
  const more = $('#moreStories');
  more.hidden = rest.length <= state.limit;
  more.textContent = `Show more stories (${rest.length - state.limit} left)`;
  renderRail();
}

function renderRail() {
  const { markets, social, models } = state.data;
  const heat = (m) => m.move * Math.log10(10 + m.volume24h);
  const moving = markets.filter((m) => m.volume24h > 1000).slice().sort((a, b) => heat(b) - heat(a)).slice(0, 6);
  $('#railMarkets').innerHTML = moving.map((m) => {
    const o = m.outcomes.slice().sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0))[0];
    const label = m.binary ? m.title : `${m.title}: ${o.label}`;
    return `<li><a class="q" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(label)}</a>
      ${barHtml(m, o)}
      <span class="row"><span>${pctHtml(m, o, 'b', 'num')} ${changeHtml(o.change24h)}</span><span class="num">$${compact(m.volume24h)} today</span></span></li>`;
  }).join('') || '<li class="rail-note">Markets are loading.</li>';

  const posts = social.filter((p) => matchesQuery(`${p.title} ${p.author}`)).slice(0, 14);
  $('#railPosts').innerHTML = posts.map((p) => `<li><a class="post" href="${esc(p.url)}" target="_blank" rel="noopener">
      <img class="av" src="${esc(p.avatar || fav(PLATFORM_HOST[p.platform]))}" alt="" loading="lazy" width="30" height="30">
      <span><span class="who"><b>${esc(p.author)}</b>${p.platform === 'x' ? `@${esc(p.handle)}` : 'Bluesky'} ${time(p.publishedAt)}</span><p>${highlight(p.title)}</p></span>
    </a></li>`).join('') || '<li class="rail-note">No posts yet. X posts appear once an X source is configured; see the Sources list at the bottom of the page.</li>';

  $('#railModels').innerHTML = models.slice(0, 8).map((m) =>
    `<li><a href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.title)}">${esc(m.title)}</a><span>${compact(m.engagement?.likes ?? m.engagement?.score)} likes</span></li>`).join('');
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
  $('#buildChips').innerHTML = BUILD_FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, l]) =>
    `<button class="chip" type="button" data-build="${k}" aria-pressed="${state.buildFilter === k}">${l}${k !== 'all' ? `<span class="n">${counts[k]}</span>` : ''}</button>`).join('');
  let list = state.data.builds.filter((b) => (state.buildFilter === 'all' || b.platform === state.buildFilter) && matchesQuery(`${b.title} ${b.summary} ${b.author}`));
  if (state.buildFilter === 'all') list = interleave(list);
  $('#buildGrid').innerHTML = list.map((b, i) => {
    const h = PLATFORM_HOST[b.platform] || host(b.url);
    const glyph = b.emoji ? esc(b.emoji) : `<img src="${esc(b.avatar || fav(b.platform === 'hn' || b.platform === 'producthunt' ? host(b.url) || h : h))}" alt="" loading="lazy">`;
    const feature = i < 2 && state.buildFilter === 'all' && !state.q ? ' feature' : '';
    return `<article class="build${feature}">
      <div class="top"><span class="glyph">${glyph}</span><span class="by"><b>${esc(b.source)}</b>${b.author ? `by ${esc(b.author)}` : ''}</span></div>
      <div><h3><a href="${esc(b.url)}" target="_blank" rel="noopener">${highlight(b.title)}</a></h3>${b.summary ? `<p>${highlight(b.summary)}</p>` : ''}</div>
      <div class="stats">${buildStats(b)}</div>
    </article>`;
  }).join('') || `<p class="empty">No projects match. Clear the search or choose Everything.</p>`;
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
  $('#marketSort').innerHTML = sorts.map(([k, l]) => `<button class="chip" type="button" data-msort="${k}" aria-pressed="${state.marketSort === k}">${l}</button>`).join('');
  let list = state.data.markets.filter((m) => matchesQuery(`${m.title} ${m.outcomes.map((o) => o.label).join(' ')}`));
  if (state.marketSort === 'moving') list = list.filter((m) => m.volume24h > 200).sort((a, b) => b.move - a.move);
  if (state.marketSort === 'volume') list.sort((a, b) => b.volume24h - a.volume24h);
  if (state.marketSort === 'linked') list = list.filter((m) => m.stories.length).sort((a, b) => b.stories.length - a.stories.length || b.volume24h - a.volume24h);
  if (state.marketSort === 'ending') list = list.filter((m) => m.endDate && Date.parse(m.endDate) > Date.now()).sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate));
  const storyById = new Map(state.data.stories.map((s) => [s.id, s]));
  $('#marketList').innerHTML = list.slice(0, 90).map((m) => `
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
    </article>`).join('') || `<p class="empty">No markets match. Clear the search to see all AI markets.</p>`;
}

// ---------- Footer ----------

const SOURCE_LABELS = { x: 'X', polymarket: 'Polymarket', hackernews: 'Hacker News', reddit: 'Reddit', bluesky: 'Bluesky', googlenews: 'Google News', rss: 'Lab blogs, press and newsletters', scraped: 'Lab news pages', openrouter: 'OpenRouter models', huggingface: 'Hugging Face', github: 'GitHub', producthunt: 'Product Hunt', showhn: 'Show HN' };

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
  state.view = ['news', 'builds', 'markets'].includes(v) ? v : 'news';
  const name = state.data?.site?.name || 'Frontier Wire';
  document.title = { news: name, builds: `Built with AI · ${name}`, markets: `AI markets · ${name}` }[state.view];
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
setInterval(updateSpiderLine, 30e3);
$('#river').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton-card" aria-hidden="true"><i class="skeleton"></i><i class="skeleton w80"></i><i class="skeleton w40"></i></div>').join('');
route();
await refresh();
updateSpiderLine();
connect();
