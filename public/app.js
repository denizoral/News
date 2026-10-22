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
  chartOpen: null, // market id whose odds chart is expanded
  charts: new Map(), // market id -> { at, outcomes } from /api/odds
  topicKey: null,
  topicCache: new Map(), // topic key -> { at, data, error } from /api/topic
  week: null, // { at, data, error, pending } from /api/digest
  related: new Map(), // story id -> { data, error, pending } from /api/related
  relOpen: new Set(), // story ids showing related coverage
  relCounts: null, // { at, data: { [release id]: { n, outlets } } } from /api/releases/coverage
  relCov: new Map(), // release id -> { data, error, pending } from /api/release
  relCovOpen: new Set(), // release ids showing their coverage
  storyId: null,
  storyCache: new Map(), // sid -> { at, data, error, pending } from /api/story
  storyAll: new Set(), // sids showing every outlet in the timeline
  emerging: null, // { at, data, pending } from /api/emerging
  themeId: null,
  themeCache: new Map(), // theme id -> { at, data, error, pending } from /api/emerging?id=
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
      <span>${oddsSpark(m.spark, 'mini')}${pctHtml(m, o)}${changeHtml(o.change24h)}</span>
      ${barHtml(m, o)}
    </div>`;
  });
  return rows.length ? `<div class="odds" aria-label="Related Polymarket odds">${rows.join('')}</div>` : '';
}

// The leading outcome's last 7 days, scaled to its own range (at least 4
// points wide, so a flat market reads as flat). Coloured by direction.
function oddsSpark(values, cls = '') {
  if (!values || values.length < 2) return '';
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(0, 0.04 - (hi - lo)) / 2;
  const min = lo - pad, span = hi - lo + 2 * pad || 1;
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`).join(' ');
  const dir = values.at(-1) - values[0];
  return `<svg class="ospark ${cls} ${dir > 0.005 ? 'up' : dir < -0.005 ? 'down' : ''}" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

// Expanded odds chart: up to four outcomes over seven days, one y-axis in
// percent, direct labels at the line ends, crosshair on hover.
// Sized to the card at render time so text stays at its CSS size.
const CHART = { w: 640, h: 200, l: 36, r: 112, t: 12, b: 24 };
function sizeChart() {
  const w = Math.max(300, Math.round(($('#marketList')?.clientWidth || 640) - 38));
  Object.assign(CHART, { w, h: w < 520 ? 180 : 240, r: w < 520 ? 104 : 150 });
}
function oddsChartHtml(id) {
  const c = state.charts.get(id);
  if (!c) return '<div class="odds-chart loading" aria-busy="true"><i class="skeleton"></i></div>';
  const series = c.outcomes.filter((o) => o.points.length > 1);
  if (!series.length) return '<div class="odds-chart"><p class="rail-note">History starts building now; check back in an hour.</p></div>';
  sizeChart();
  const all = series.flatMap((o) => o.points);
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  let lo = Math.min(...all.map((p) => p[1])), hi = Math.max(...all.map((p) => p[1]));
  lo = Math.max(0, Math.floor((lo - 0.02) * 10) / 10);
  hi = Math.min(1, Math.ceil((hi + 0.02) * 10) / 10);
  const { w, h, l, r, t, b } = CHART;
  const x = (ts) => l + ((ts - t0) / (t1 - t0 || 1)) * (w - l - r);
  const y = (v) => t + (1 - (v - lo) / (hi - lo || 1)) * (h - t - b);
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((v) => `<line class="grid" x1="${l}" x2="${w - r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const days = [];
  for (let d = new Date(t0).setHours(0, 0, 0, 0) + 86400e3; d < t1; d += 86400e3) days.push(d);
  const dayTicks = days.filter((_, i) => days.length <= 7 || i % 2 === 0).map((d) => `<text class="axis" x="${x(d).toFixed(1)}" y="${h - 6}" text-anchor="middle">${new Date(d).toLocaleDateString(undefined, { weekday: 'short' })}</text>`).join('');
  // Direct labels at the right edge, nudged apart so they never overlap.
  const ends = series.map((o, i) => ({ i, o, y: y(o.points.at(-1)[1]) })).sort((a, z) => a.y - z.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
  const lines = series.map((o, i) => `<polyline class="s${i + 1}" points="${o.points.map(([ts, v]) => `${x(ts).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  const dots = series.map((o, i) => { const [ts, v] = o.points.at(-1); return `<circle class="s${i + 1}" cx="${x(ts).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4"/>`; }).join('');
  const labels = ends.map(({ i, o, y: ly }) => `<text class="end" x="${w - r + 10}" y="${(ly + 4).toFixed(1)}">${esc(o.label.length > (CHART.w < 520 ? 10 : 16) ? `${o.label.slice(0, CHART.w < 520 ? 9 : 15)}…` : o.label)} ${pct(o.points.at(-1)[1])}</text>`).join('');
  const legend = series.length > 1 ? `<ul class="odds-legend">${series.map((o, i) => `<li><i class="s${i + 1}"></i>${esc(o.label)}</li>`).join('')}</ul>` : '';
  return `<div class="odds-chart" data-chart="${esc(id)}" data-t0="${t0}" data-t1="${t1}">
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Odds over the last 7 days">${grid}${dayTicks}<g class="lines">${lines}</g>${dots}${labels}<line class="cross" y1="${t}" y2="${h - b}" x1="0" x2="0"/></svg>
    <div class="odds-tip" hidden></div>${legend}</div>`;
}

async function toggleChart(id) {
  state.chartOpen = state.chartOpen === id ? null : id;
  transition(renderMarkets);
  const cached = state.charts.get(id);
  if (!state.chartOpen || (cached && Date.now() - cached.at < 120e3)) return;
  try {
    const res = await fetch(`api/odds?id=${encodeURIComponent(id)}`);
    const data = res.ok ? await res.json() : { outcomes: [] };
    state.charts.set(id, { at: Date.now(), outcomes: data.outcomes });
  } catch {
    state.charts.set(id, { at: Date.now(), outcomes: [] });
  }
  if (state.view === 'markets') renderMarkets();
}

function chartHover(e) {
  const box = e.target.closest('.odds-chart[data-chart]');
  const c = box && state.charts.get(box.dataset.chart);
  if (!c) return;
  const svg = box.querySelector('svg');
  const tip = box.querySelector('.odds-tip');
  const cross = box.querySelector('.cross');
  const rect = svg.getBoundingClientRect();
  const { w, l, r } = CHART;
  const px = ((e.clientX - rect.left) / rect.width) * w;
  if (e.type === 'pointerleave' || px < l || px > w - r) { tip.hidden = true; cross.classList.remove('on'); return; }
  const t0 = +box.dataset.t0, t1 = +box.dataset.t1;
  const ts = t0 + ((px - l) / (w - l - r)) * (t1 - t0);
  const series = c.outcomes.filter((o) => o.points.length > 1);
  const rows = series.map((o, i) => {
    let v = null;
    for (const p of o.points) { if (p[0] > ts) break; v = p[1]; }
    return v == null ? '' : `<li><i class="s${i + 1}"></i>${esc(o.label)} <b>${pct(v)}</b></li>`;
  }).join('');
  cross.setAttribute('x1', px.toFixed(1));
  cross.setAttribute('x2', px.toFixed(1));
  cross.classList.add('on');
  tip.innerHTML = `<time>${new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</time><ul>${rows}</ul>`;
  tip.hidden = false;
  const left = (px / w) * rect.width;
  tip.style.transform = `translateX(${left > rect.width / 2 ? `calc(${left - 12}px - 100%)` : `${left + 12}px`})`;
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
  const link = storyLink(story);
  return coverageList(story.sources) + (link ? `<a class="story-go" href="${link}">Full coverage: how it spread, the brief, reactions →</a>` : '');
}

function coverageList(sources) {
  return `<ul class="sources-list">${sources.map((s) => {
    const h = s.platform === 'web' ? s.host || host(s.url) : PLATFORM_HOST[s.platform];
    return `<li><img class="fav" src="${esc(s.avatar || fav(h))}" alt="" loading="lazy" width="16" height="16">
      <a href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.name)}</b>${s.text ? `<q>${esc(s.text)}</q>` : ''}</a>
      ${s.publishedAt ? time(s.publishedAt) : '<span></span>'}</li>`;
  }).join('')}</ul>`;
}

// Related coverage: the closest stored articles by meaning (embeddings),
// earlier reporting included, that aren't copies of this story.
const relatedBtn = (s) => state.mode === 'api' ? `<button class="coverage related-btn" type="button" data-related="${esc(s.id)}" aria-expanded="${state.relOpen.has(s.id)}">Related</button>` : '';

async function loadRelated(id) {
  if (state.related.get(id)) return;
  state.related.set(id, { pending: true });
  let entry;
  try {
    const res = await fetch(`api/related?id=${encodeURIComponent(id)}`);
    const body = await res.json();
    entry = res.ok ? { data: body } : { error: body.error };
  } catch (e) {
    entry = { error: e.message };
  }
  state.related.set(id, entry);
  if (state.relOpen.has(id)) transition(render);
}

function relatedHtml(s) {
  if (!state.relOpen.has(s.id)) return '';
  const e = state.related.get(s.id);
  if (!e || e.pending) return '<div class="related" aria-busy="true"><h4>Related coverage</h4><i class="skeleton"></i><i class="skeleton"></i><i class="skeleton"></i></div>';
  if (e.error) return `<div class="related"><h4>Related coverage</h4><p class="rail-note">${esc(e.error)}</p></div>`;
  const rows = e.data.results;
  return `<div class="related"><h4>Related coverage</h4>${rows.length ? `<ul>${rows.map((r, i) => `<li style="--i:${i}"><img src="${esc(fav(r.site))}" alt="" width="16" height="16" loading="lazy">
    <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><span>${esc(r.source || r.site)}${r.publishedAt ? ` · ${shortDate(r.publishedAt)}` : ''}</span></li>`).join('')}</ul>` : '<p class="rail-note">Nothing close enough in the index yet.</p>'}</div>`;
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
  const link = storyLink(s);
  const hot = s.sources.length >= 4 ? (link ? `<a class="hot" href="${link}" title="How this story developed">Developing</a>` : `<span class="hot">Developing</span>`) : '';
  return `<article class="story${read}${thumb ? ' has-thumb' : ''}" data-id="${esc(s.id)}">
    <h3><a href="${esc(s.url)}" target="_blank" rel="noopener" data-read="${esc(s.id)}">${highlight(s.title)}</a></h3>
    ${dek && s.summary && s.summary !== s.title && !isUrlOnly(s.summary) ? `<p class="dek">${highlight(s.summary)}</p>` : ''}
    ${thumb}
    <div class="meta">${hot}${sourceBadge(s)}${time(s.publishedAt)}${firstHtml(s)}${coverageHtml(s)}${relatedBtn(s)}${engagementHtml(s)}${s.topics.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${sourcesListHtml(s)}
    ${relatedHtml(s)}
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
    html = `<p class="entity-bar">Stories about <b>${esc(label)}</b> <a class="chip chip-go" href="#topic/${esc(state.entity)}">30-day history →</a> <button class="chip" type="button" data-entity="${esc(state.entity)}">Show all stories</button></p>` + html;
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
  renderEmergingRail();
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
    relCovBtn(r),
  ].filter(Boolean).join('');
  return `<li class="rel" data-id="${esc(r.id)}">
    <img class="rel-logo" src="${esc(releaseLogo(r))}" alt="" width="32" height="32" loading="lazy">
    <div class="rel-main">
      <div class="rel-title"><a href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.summary || r.name)}">${highlight(r.name)}</a>${isNew ? '<span class="rel-new">New</span>' : ''}</div>
      <div class="rel-by">${esc(r.provider)}</div>
      <div class="rel-meta">${meta}</div>
    </div>
    <time class="rel-date" datetime="${new Date(r.date).toISOString()}">${shortDate(r.date)}</time>
    ${relCovHtml(r)}
  </li>`;
}

// Coverage since launch (server: src/index/releases.js): the row shows how many
// stories named the model; it opens to a count per day and the stories, with
// the first one to report it marked.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function loadRelCounts() {
  const c = state.relCounts;
  if (state.mode !== 'api' || c?.pending || (c && Date.now() - c.at < 5 * 60e3)) return;
  state.relCounts = { ...c, pending: true };
  let data = c?.data || {};
  try {
    const res = await fetch('api/releases/coverage');
    if (res.ok) data = await res.json();
  } catch {}
  state.relCounts = { at: Date.now(), data };
  if (state.view === 'releases') transition(() => renderReleases());
}

async function loadRelCov(id) {
  if (state.relCov.get(id)) return;
  state.relCov.set(id, { pending: true });
  let entry;
  try {
    const res = await fetch(`api/release?id=${encodeURIComponent(id)}`);
    const body = await res.json();
    entry = res.ok ? { data: body } : { error: body.error };
  } catch (e) {
    entry = { error: e.message };
  }
  state.relCov.set(id, entry);
  if (state.relCovOpen.has(id) && state.view === 'releases') transition(() => renderReleases());
}

function relCovBtn(r) {
  const c = state.relCounts?.data?.[r.id];
  if (c?.n) return `<button class="rel-story rel-cov-btn" type="button" data-relcov="${esc(r.id)}" aria-expanded="${state.relCovOpen.has(r.id)}" title="${esc(`Named in ${plural(c.n, 'story', 'stories')} from ${plural(c.outlets, 'outlet')} since launch`)}">${plural(c.n, 'story', 'stories')}</button>`;
  return r.story ? `<a class="rel-story" href="${esc(r.story.url)}" target="_blank" rel="noopener">In the news ↗</a>` : '';
}

// Stories per day, the day before launch first; one bar per day.
function relBarsHtml(series) {
  const max = Math.max(1, ...series.map((d) => d.n));
  const slot = Math.min(20, Math.max(8, Math.floor(280 / series.length))); // a short run still reads as a chart
  const w = series.length * slot;
  const bars = series.map((d, i) => {
    const h = d.n ? Math.max(2, (d.n / max) * 30) : 0;
    return `<rect x="${i * slot + 1}" y="${32 - h}" width="${slot - 2}" height="${h}" rx="${Math.min(3, (slot - 2) / 2)}" style="--i:${i}"><title>${esc(dayLabel(d.day, { month: 'short', day: 'numeric' }))}: ${plural(d.n, 'story', 'stories')}</title></rect>`;
  }).join('');
  return `<figure class="rel-bars"><svg viewBox="0 0 ${w} 33" width="${w}" height="33" role="img" aria-label="Stories per day since launch">${bars}<line x1="0" x2="${w}" y1="32.5" y2="32.5"/></svg>
    <figcaption><span>${esc(dayLabel(series[0].day, { month: 'short', day: 'numeric' }))}</span><span>${esc(dayLabel(series.at(-1).day, { month: 'short', day: 'numeric' }))}</span></figcaption></figure>`;
}

function relCovHtml(r) {
  if (!state.relCovOpen.has(r.id)) return '';
  const e = state.relCov.get(r.id);
  if (!e || e.pending) return '<div class="related rel-cov" aria-busy="true"><i class="skeleton"></i><i class="skeleton"></i><i class="skeleton"></i></div>';
  if (e.error) return `<div class="related rel-cov"><p class="rail-note">${esc(e.error)}</p></div>`;
  const c = e.data;
  if (!c.n) return '<div class="related rel-cov"><p class="rail-note">No stories name it yet.</p></div>';
  const first = c.first;
  return `<div class="related rel-cov">
    <p class="rel-cov-sum"><b>${plural(c.n, 'story', 'stories')}</b> from ${plural(c.outlets, 'outlet')} since launch.
      First: <a href="${esc(first.url)}" target="_blank" rel="noopener">${esc(first.source)}</a>, ${shortDate(first.at)}.</p>
    ${c.series.length > 1 ? relBarsHtml(c.series) : ''}
    <ul>${c.items.map((it, i) => `<li style="--i:${i}"><img src="${esc(fav(it.platform ? PLATFORM_HOST[it.platform] : it.site))}" alt="" width="16" height="16" loading="lazy">
      <a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
      <span>${it.url === first.url ? '<em class="rel-first">First</em> ' : ''}${esc(it.source)}${it.outlets > 1 ? ` +${it.outlets - 1}` : ''} · ${shortDate(it.at)}</span></li>`).join('')}</ul>
  </div>`;
}

function renderReleases({ animate = false } = {}) {
  loadRelCounts();
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
    <article class="market${state.chartOpen === m.id ? ' charted' : ''}" data-id="${esc(m.id)}">
      <header>${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : '<span></span>'}
        <div><h3><a href="${esc(m.url)}" target="_blank" rel="noopener">${highlight(m.title)}</a></h3>
        <span class="vol num">$${compact(m.volume24h)} traded today, $${compact(m.volume)} total${m.endDate ? `, ends ${new Date(m.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</span></div>
      </header>
      ${m.spark ? `<button class="odds-trend" type="button" data-chart-toggle="${esc(m.id)}" aria-expanded="${state.chartOpen === m.id}"${state.mode === 'api' ? '' : ' disabled'}>
        ${oddsSpark(m.spark)}<span class="num">7 days <b>${pct(m.spark[0])} → ${pct(m.spark.at(-1))}</b></span>${state.mode === 'api' ? '<span class="odds-more">Chart</span>' : ''}</button>` : ''}
      ${state.chartOpen === m.id ? oddsChartHtml(m.id) : ''}
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

// ---------- Topic pages ----------
// #topic/<key>: a company or theme's share of all coverage over 30 days, a
// dated timeline of its biggest headlines (from the stored index), and what's
// live about it now (from the snapshot).

const dayLabel = (day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, opts);
const topicName = (key) => state.topicCache.get(key)?.data?.label || trendData()?.topics.find((x) => x.key === key)?.label || key;

async function loadTopic(key) {
  const hit = state.topicCache.get(key);
  if (state.mode !== 'api' || (hit && (hit.pending || Date.now() - hit.at < 5 * 60e3))) return;
  state.topicCache.set(key, { ...hit, pending: true });
  let data = hit?.data || null;
  let error = null;
  try {
    const res = await fetch(`api/topic?key=${encodeURIComponent(key)}`);
    const body = await res.json();
    if (res.ok) data = body;
    else error = body.error;
  } catch (e) {
    error = e.message;
  }
  state.topicCache.set(key, { at: Date.now(), data, error, fresh: true });
  if (state.view === 'topic' && state.topicKey === key) renderTopic();
}

const TCHART = { w: 720, h: 150, l: 40, r: 8, t: 10, b: 22 };
function topicChartHtml(series, animate) {
  const w = TCHART.w = Math.max(280, Math.round(($('#topicView')?.clientWidth || 720) - (innerWidth <= 560 ? 34 : 42)));
  const { h, l, r, t, b } = TCHART;
  const max = Math.max(0.01, ...series.map((d) => d.share));
  const top = Math.ceil(max * 100 / 5) * 5 / 100 || 0.05;
  const slot = (w - l - r) / series.length;
  const bw = Math.max(2, slot - 2);
  const y = (v) => t + (1 - v / top) * (h - t - b);
  const grid = [0, top / 2, top].map((v) => `<line class="grid" x1="${l}" x2="${w - r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${+(v * 100).toFixed(1)}%</text>`).join('');
  const today = series.length - 1;
  const bars = series.map((d, i) => {
    const x = l + i * slot + 1;
    const hgt = Math.max(d.n ? 2 : 0, y(0) - y(d.share));
    return `<rect class="bar${i === today ? ' partial' : ''}" x="${x.toFixed(1)}" y="${(y(0) - hgt).toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" rx="${Math.min(3, bw / 2)}" style="--i:${i}"/>`;
  }).join('');
  const ticks = series.map((d, i) => ({ d, i })).filter(({ i }) => i % 7 === (today % 7)).map(({ d, i }) => `<text class="axis" x="${(l + i * slot + slot / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${dayLabel(d.day, { month: 'short', day: 'numeric' })}</text>`).join('');
  return `<div class="topic-chart${animate ? ' animate' : ''}">
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Share of all coverage per day, last ${series.length} days">${grid}<g class="bars">${bars}</g>${ticks}</svg>
    <div class="odds-tip" hidden></div>
  </div>`;
}

function topicHover(e) {
  const box = e.target.closest('.topic-chart');
  const data = state.topicCache.get(state.topicKey)?.data;
  if (!box || !data) return;
  const tip = box.querySelector('.odds-tip');
  const rect = box.querySelector('svg').getBoundingClientRect();
  const { w, l, r } = TCHART;
  const px = ((e.clientX - rect.left) / rect.width) * w;
  const i = Math.floor(((px - l) / (w - l - r)) * data.series.length);
  const d = data.series[i];
  for (const el of box.querySelectorAll('.bar.on')) el.classList.remove('on');
  if (e.type === 'pointerleave' || !d) { tip.hidden = true; return; }
  box.querySelectorAll('.bar')[i]?.classList.add('on');
  tip.innerHTML = `<time>${dayLabel(d.day)}${i === data.series.length - 1 ? ' (so far)' : ''}</time><ul><li><b>${d.n.toLocaleString()}</b> mentions</li><li><b>${+(d.share * 100).toFixed(1)}%</b> of ${d.total.toLocaleString()} stored stories</li></ul>`;
  tip.hidden = false;
  const left = (px / w) * rect.width;
  tip.style.transform = `translateX(${left > rect.width / 2 ? `calc(${left - 12}px - 100%)` : `${left + 12}px`})`;
}

let topicShown = '';
function renderTopic() {
  const key = state.topicKey;
  const entry = state.topicCache.get(key);
  const data = entry?.data;
  const label = topicName(key);
  document.title = `${label} · ${state.data?.site?.name || 'Frontier Wire'}`;
  // Animate when a page first gets its data, not on every live update.
  const animate = !!data && topicShown !== `${key}:${data.generatedAt}` && !reducedMotion();
  if (data) topicShown = `${key}:${data.generatedAt}`;

  const live = (state.data?.stories || []).filter((s) => s.entities.includes(key)).slice(0, 6);
  const markets = (state.data?.markets || []).filter((m) => m.entities?.includes(key)).sort((a, b) => b.volume24h - a.volume24h).slice(0, 4);
  const trend = trendData()?.topics.find((x) => x.key === key);

  const summary = data
    ? `${data.total.toLocaleString()} mentions in ${data.days} days${data.peak ? ` · busiest ${dayLabel(data.peak, { month: 'short', day: 'numeric' })}` : ''}${trend?.lift >= 1.2 ? ` · trending, ${trend.lift}× its usual pace` : ''}`
    : entry?.error ? `History is unavailable: ${esc(entry.error)}` : state.mode === 'api' ? 'Counting coverage…' : 'History needs the live server.';

  const chart = data ? topicChartHtml(data.series, animate) : state.mode === 'api' && !entry?.error ? '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>' : '';
  const timeline = data?.timeline.length ? data.timeline.map((d, k) => `
    <li class="tl-day" style="--i:${Math.min(k, 10)}">
      <h3><time datetime="${d.day}">${dayLabel(d.day)}</time><span>${d.count.toLocaleString()} mentions</span></h3>
      <ul>${d.items.map((it) => `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <span class="tl-meta"><img src="${esc(fav(it.site))}" alt="" loading="lazy" width="14" height="14">${esc(it.source)}${it.outlets > 1 ? ` · ${it.outlets} outlets` : ''}</span></li>`).join('')}</ul>
    </li>`).join('') : '';

  setHtml($('#topicView'), `
    <header class="topic-head">
      <a class="back" href="#news">← News</a>
      <p class="kicker">Topic</p>
      <h1>${esc(label)}</h1>
      <p class="topic-sum">${summary}</p>
    </header>
    ${chart ? `<section class="topic-card"><h2>Share of all coverage <small>last 30 days, every stored story</small></h2>${chart}</section>` : ''}
    <div class="topic-grid">
      <section class="topic-timeline">
        <h2>Timeline</h2>
        ${timeline ? `<ol class="tl${animate ? ' animate' : ''}">${timeline}</ol>` : `<p class="rail-note">${data ? 'No headlines about this topic in the last two weeks.' : ''}</p>`}
      </section>
      <aside class="topic-side">
        <section><h2>In the news now</h2>
          ${live.length ? `<ul class="topic-live">${live.map((s) => `<li data-id="${esc(s.id)}"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><span class="tl-meta">${esc(s.lead.source)} · ${time(s.publishedAt)}${s.sources.length > 1 ? ` · ${s.sources.length} sources` : ''}</span></li>`).join('')}</ul>` : '<p class="rail-note">Nothing in the live feed right now.</p>'}
        </section>
        ${markets.length ? `<section><h2>Markets</h2><ul class="topic-markets">${markets.map((m) => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>
          <span class="tm-row">${oddsSpark(m.spark, 'mini')}<b>${pct(m.outcomes[0].yes)}</b>${m.binary ? '' : ` ${esc(m.outcomes[0].label)}`}${changeHtml(m.outcomes[0].change24h)}</span></li>`).join('')}</ul></section>` : ''}
      </aside>
    </div>`);
  loadTopic(key);
}

// ---------- Emerging themes ----------
// Groups of live stories whose coverage is accelerating (server:
// src/index/emerging.js): a rail block on the front page, and #theme/<id>
// with the hour-by-hour build-up and every story in it.

async function loadEmerging() {
  const hit = state.emerging;
  if (state.mode !== 'api' || hit?.pending || (hit && Date.now() - hit.at < 5 * 60e3)) return;
  state.emerging = { ...hit, pending: true };
  let data = hit?.data || null;
  try {
    const res = await fetch('api/emerging');
    if (res.ok) data = await res.json();
  } catch {}
  state.emerging = { at: Date.now(), data };
  if (state.view === 'news') transition(renderEmergingRail);
}

const themeTitle = (t) => t.name.length ? t.name.join(' · ') : t.headline;
const paceLabel = (t) => (t.isNew ? '<span class="em-new">New</span>' : `<span class="em-pace" title="Reports per hour in the last ${t.recent ? 12 : 0} hours against the 36 before">↑ ${t.growth}×</span>`);

// 48 hourly counts as a bar strip; the last 12 hours carry the colour.
function emSpark(spark, { w = 96, h = 20 } = {}) {
  const max = Math.max(1, ...spark);
  const slot = w / spark.length;
  return `<svg class="em-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${spark.map((n, i) => {
    const bh = n ? Math.max(1.5, (n / max) * h) : 0;
    return bh ? `<rect class="${i >= spark.length - 12 ? 'hot' : ''}" x="${(i * slot).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${Math.max(1, slot - 0.6).toFixed(2)}" height="${bh.toFixed(2)}"/>` : '';
  }).join('')}</svg>`;
}

function renderEmergingRail() {
  const block = $('#railEmerging');
  if (!block) return;
  loadEmerging();
  const themes = state.emerging?.data?.themes?.slice(0, 5) || [];
  block.hidden = !themes.length;
  if (!themes.length) return;
  setHtml($('#emergingList'), themes.map((t, i) => `<li style="--i:${i}"><a href="#theme/${esc(t.id)}">
    <b>${esc(themeTitle(t))}</b>
    <span class="em-head">${esc(t.headline)}</span>
    <span class="em-row">${emSpark(t.spark)}${paceLabel(t)}<span>${t.n} stories · ${t.outlets} outlets</span></span></a></li>`).join(''));
}

async function loadTheme(id) {
  const hit = state.themeCache.get(id);
  if (state.mode !== 'api' || hit?.pending || (hit && Date.now() - hit.at < 2 * 60e3)) return;
  state.themeCache.set(id, { ...hit, pending: true });
  let data = hit?.data || null;
  let error = null;
  try {
    const res = await fetch(`api/emerging?id=${encodeURIComponent(id)}`);
    const body = await res.json();
    if (res.ok) data = body;
    else error = body.error;
  } catch (e) {
    error = e.message;
  }
  state.themeCache.set(id, { at: Date.now(), data, error });
  if (state.view === 'theme' && state.themeId === id) transition(renderTheme);
}

const ECHART = { h: 150, l: 30, r: 8, t: 10, b: 22 };
function themeChartHtml(t, animate) {
  const w = ECHART.w = Math.max(280, Math.round(($('#themeView')?.clientWidth || 720) - (innerWidth <= 560 ? 34 : 42)));
  const { h, l, r, t: top, b } = ECHART;
  const n = t.spark.length;
  const max = Math.max(2, ...t.spark);
  const ceil = Math.ceil(max / 2) * 2;
  const slot = (w - l - r) / n;
  const bw = Math.max(2, slot - 2);
  const y = (v) => top + (1 - v / ceil) * (h - top - b);
  const grid = [0, ceil / 2, ceil].map((v) => `<line class="grid" x1="${l}" x2="${w - r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('');
  const bars = t.spark.map((v, i) => {
    const bh = v ? Math.max(2, y(0) - y(v)) : 0;
    return bh ? `<rect class="bar${i >= n - 12 ? ' recent' : ''}${i === n - 1 ? ' partial' : ''}" x="${(l + i * slot + 1).toFixed(1)}" y="${(y(0) - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(3, bw / 2)}" style="--i:${i}"/>` : '';
  }).join('');
  const split = l + (n - 12) * slot;
  const ticks = [[0, '48h ago'], [n - 24, '24h ago'], [n - 12, '12h ago'], [n - 1, 'Now']].map(([i, s]) => `<text class="axis" x="${(l + i * slot + slot / 2).toFixed(1)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${s}</text>`).join('');
  return `<div class="topic-chart theme-chart${animate ? ' animate' : ''}">
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Reports per hour over the last 48 hours">${grid}<line class="split" x1="${split.toFixed(1)}" x2="${split.toFixed(1)}" y1="${top}" y2="${h - b}"/><g class="bars">${bars}</g>${ticks}</svg>
  </div>`;
}

let themeShown = '';
function renderTheme() {
  const id = state.themeId;
  const entry = state.themeCache.get(id);
  const t = entry?.data || state.emerging?.data?.themes?.find((x) => x.id === id);
  const site = state.data?.site?.name || 'Frontier Wire';
  if (!t) {
    document.title = `Emerging · ${site}`;
    setHtml($('#themeView'), `<header class="topic-head"><a class="back" href="#news">← News</a><p class="kicker">Emerging theme</p>
      ${entry?.error ? `<h1>No longer rising</h1><p class="topic-sum">${esc(entry.error)} Its stories are still on their story pages.</p>` : '<i class="skeleton sk-title"></i><i class="skeleton"></i>'}</header>`);
    return loadTheme(id);
  }
  document.title = `${themeTitle(t)} · ${site}`;
  const full = entry?.data;
  const animate = !!full && themeShown !== `${id}:${full.generatedAt}` && !reducedMotion();
  if (full) themeShown = `${id}:${full.generatedAt}`;
  const pace = t.isNew ? 'new in the last 12 hours' : `${t.growth}× the pace of the 36 hours before`;
  const stories = (full || t).stories;
  setHtml($('#themeView'), `
    <header class="topic-head">
      <a class="back" href="#news">← News</a>
      <p class="kicker">Emerging theme${t.entities.length ? ` · ${t.entities.map((k) => `<a href="#topic/${esc(k)}">${esc(topicName(k))}</a>`).join(', ')}` : ''}</p>
      <h1>${esc(themeTitle(t))}</h1>
      <p class="topic-sum"><b>${t.recent}</b> reports in the last 12 hours, ${pace} · ${t.n} stories from ${t.outlets} outlets</p>
    </header>
    <section class="topic-card"><h2>Reports per hour <small>last 48 hours; the last 12 in colour</small></h2>${themeChartHtml(t, animate)}</section>
    <section class="story-card"><h2>Stories <small>biggest first; each opens its story page</small></h2>
      <ol class="theme-stories${animate ? ' animate' : ''}">${stories.map((s, i) => `<li style="--i:${Math.min(i, 14)}">
        <a href="#story/${esc(s.sid)}">${esc(s.title)}</a>
        <span class="tl-meta">${esc(s.source || '')}${s.sources > 1 ? ` · ${s.sources} sources` : ''} · ${time(s.publishedAt)}</span></li>`).join('')}</ol>
      ${!full ? '<p class="rail-note">Loading every story…</p>' : ''}
    </section>`);
  loadTheme(id);
}

// ---------- Story pages ----------
// #story/<sid>: one story in full (server: src/index/storypage.js). How it
// spread (who reported it when), a brief across outlets, X reactions, linked
// markets with the move since it broke, and earlier background. Story ids are
// stable, so the link keeps working after the story leaves the feed.

const storyLink = (s) => (s.sid && state.mode === 'api' ? `#story/${encodeURIComponent(s.sid)}` : null);

function sinceLabel(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 60) return `+${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `+${h}h${m % 60 && h < 10 ? ` ${m % 60}m` : ''}`;
  return `+${Math.round(h / 24)}d`;
}

async function loadStory(sid) {
  const hit = state.storyCache.get(sid);
  if (state.mode !== 'api' || (hit && (hit.pending || Date.now() - hit.at < 2 * 60e3))) return;
  state.storyCache.set(sid, { ...hit, pending: true });
  let data = hit?.data || null;
  let error = null;
  try {
    const res = await fetch(`api/story?id=${encodeURIComponent(sid)}`);
    const body = await res.json();
    if (res.ok) data = body;
    else error = body.error;
  } catch (e) {
    error = e.message;
  }
  state.storyCache.set(sid, { at: Date.now(), data, error });
  if (state.view === 'story' && state.storyId === sid) transition(renderStory);
}

// Outlets covering the story over time: a step line from the first report.
const SCHART = { h: 170, l: 34, r: 12, t: 12, b: 24 };
function spreadChartHtml(d, animate) {
  const pts = d.growth;
  if (pts.length < 2) return '';
  const w = SCHART.w = Math.max(280, Math.round(($('#storyView .story-main')?.clientWidth || 640) - (innerWidth <= 560 ? 34 : 42)));
  const { h, l, r, t, b } = SCHART;
  const t0 = pts[0][0];
  const t1 = Math.max(pts.at(-1)[0], t0 + 3600e3);
  const top = Math.max(2, pts.at(-1)[1]);
  const x = (ts) => l + ((ts - t0) / (t1 - t0)) * (w - l - r);
  const y = (n) => t + (1 - n / top) * (h - t - b);
  let path = `M${x(t0).toFixed(1)},${y(0).toFixed(1)}`;
  for (const [ts, n] of pts) path += ` H${x(ts).toFixed(1)} V${y(n).toFixed(1)}`;
  path += ` H${(w - r).toFixed(1)}`;
  const area = `${path} V${y(0).toFixed(1)} H${x(t0).toFixed(1)} Z`;
  const grid = [0, Math.round(top / 2), top].map((v) => `<line class="grid" x1="${l}" x2="${w - r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('');
  const span = t1 - t0;
  const step = [1, 3, 6, 12, 24, 48, 96].map((hh) => hh * 3600e3).find((s) => span / s <= 6) || 7 * 86400e3;
  const ticks = [];
  for (let ts = t0; ts <= t1; ts += step) ticks.push(`<text class="axis" x="${x(ts).toFixed(1)}" y="${h - 6}" text-anchor="${ts === t0 ? 'start' : 'middle'}">${ts === t0 ? 'First report' : sinceLabel(ts - t0)}</text>`);
  const dots = pts.map(([ts, n], i) => `<circle class="dot" cx="${x(ts).toFixed(1)}" cy="${y(n).toFixed(1)}" r="3.5" style="--i:${Math.min(i, 40)}"/>`).join('');
  return `<div class="spread-chart${animate ? ' animate' : ''}">
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Outlets covering the story over time: ${top} in ${sinceLabel(t1 - t0).slice(1)}">${grid}<path class="area" d="${area}"/><path class="line" d="${path}" pathLength="1"/><g class="dots">${dots}</g>${ticks.join('')}<line class="cross" y1="${t}" y2="${h - b}" x1="0" x2="0"/></svg>
    <div class="odds-tip" hidden></div>
  </div>`;
}

function spreadHover(e) {
  const box = e.target.closest('.spread-chart');
  const d = state.storyCache.get(state.storyId)?.data;
  if (!box || !d) return;
  const tip = box.querySelector('.odds-tip');
  const cross = box.querySelector('.cross');
  const rect = box.querySelector('svg').getBoundingClientRect();
  const { w, l, r } = SCHART;
  const px = ((e.clientX - rect.left) / rect.width) * w;
  const t0 = d.growth[0][0];
  const t1 = Math.max(d.growth.at(-1)[0], t0 + 3600e3);
  const ts = t0 + ((px - l) / (w - l - r)) * (t1 - t0);
  if (e.type === 'pointerleave' || ts < t0 - 60e3 || ts > t1 + (t1 - t0) * 0.05) { tip.hidden = true; cross.style.opacity = 0; return; }
  // The latest report at or before the pointer.
  let k = 0;
  while (k + 1 < d.growth.length && d.growth[k + 1][0] <= ts) k++;
  const [at, n] = d.growth[k];
  const who = d.timeline.find((x) => x.at === at)?.name || d.reactions.find((x) => x.at === at)?.name || '';
  setHtml(tip, `<time>${sinceLabel(at - t0)} · ${new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><ul><li><b>${n}</b> ${n === 1 ? 'outlet' : 'outlets'}</li>${who ? `<li>Latest: ${esc(who)}</li>` : ''}</ul>`);
  tip.hidden = false;
  const cx = l + ((at - t0) / (t1 - t0)) * (w - l - r);
  cross.setAttribute('x1', cx);
  cross.setAttribute('x2', cx);
  cross.style.opacity = 1;
  const left = (cx / w) * rect.width;
  tip.style.transform = `translateX(${left > rect.width / 2 ? `calc(${left - 12}px - 100%)` : `${left + 12}px`})`;
}

// One market's leading outcome over the story's window, the moment it broke marked.
function storyMarketHtml(m, firstAt) {
  const o = m.outcomes[0];
  const pts = o?.points || [];
  let chart = '';
  if (pts.length > 1) {
    const w = 260, h = 56, p = 3;
    const ta = pts[0][0], tb = pts.at(-1)[0];
    const ys = pts.map(([, v]) => v);
    const lo = Math.max(0, Math.min(...ys) - 0.03), hi = Math.min(1, Math.max(...ys) + 0.03);
    const x = (ts) => p + ((ts - ta) / Math.max(1, tb - ta)) * (w - 2 * p);
    const y = (v) => p + (1 - (v - lo) / Math.max(0.01, hi - lo)) * (h - 2 * p);
    const line = pts.map(([ts, v]) => `${x(ts).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const mark = firstAt > ta && firstAt < tb ? `<line class="broke" x1="${x(firstAt).toFixed(1)}" x2="${x(firstAt).toFixed(1)}" y1="0" y2="${h}"/>` : '';
    chart = `<svg class="sm-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${mark}<polyline points="${line}" pathLength="1"/></svg>`;
  }
  const mv = m.move;
  const move = mv && Math.abs(mv.change) >= 0.005
    ? `<span class="sm-move ${mv.change > 0 ? 'up' : 'down'}">${pct(mv.from)} → <b>${pct(mv.to)}</b> since the story broke</span>`
    : mv ? `<span class="sm-move">Steady at <b>${pct(mv.to)}</b> since the story broke</span>` : o?.yes != null ? `<span class="sm-move"><b>${pct(o.yes)}</b>${m.binary ? '' : ` ${esc(o.label)}`}</span>` : '';
  return `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>${chart}${move}${chart && mv ? '<small class="sm-key"><i></i>Story broke</small>' : ''}</li>`;
}

let storyShown = '';
function renderStory() {
  const sid = state.storyId;
  const entry = state.storyCache.get(sid);
  const d = entry?.data;
  // The feed copy shows at once while the full page loads.
  const live = (state.data?.stories || []).concat(state.data?.tech || []).find((s) => s.sid === sid);
  const title = d?.title || live?.title || '';
  document.title = `${title || 'Story'} · ${state.data?.site?.name || 'Frontier Wire'}`;
  const animate = !!d && storyShown !== `${sid}:${d.generatedAt}` && !reducedMotion();
  if (d) storyShown = `${sid}:${d.generatedAt}`;
  if (!d && !live) {
    setHtml($('#storyView'), `<header class="topic-head"><a class="back" href="#news">← News</a><p class="kicker">Story</p>
      ${entry?.error ? `<h1>Story not found</h1><p class="topic-sum">${esc(entry.error)}</p>` : '<i class="skeleton sk-title"></i><i class="skeleton"></i>'}</header>`);
    return loadStory(sid);
  }
  const first = d?.firstAt || live?.publishedAt;
  const lead = d?.lead;
  const outlets = d?.outlets ?? live?.sources.length ?? 0;
  const entities = (d?.entities || live?.entities || []).slice(0, 4);
  const summary = d?.summary || live?.summary || '';
  const image = d?.image || live?.image;
  const status = d && !d.live ? 'Archived' : outlets >= 4 ? 'Developing' : 'Story';
  const meta = [
    lead?.name ? `First reported by <b>${esc(lead.name)}</b>` : '',
    first ? time(first) : '',
    outlets > 1 ? `${outlets} outlets` : '',
    d?.lastAt && d.lastAt - first > 3600e3 ? `latest ${time(d.lastAt)}` : '',
  ].filter(Boolean).join(' · ');

  const brief = d?.brief?.length
    ? `<section class="story-card"><h2>The brief <small>sentences picked from the coverage</small></h2><ol class="brief${animate ? ' animate' : ''}">${d.brief.map((b, i) => `<li style="--i:${i}"><p>${esc(b.text)}</p><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.source)}</a></li>`).join('')}</ol></section>`
    : '';
  const chart = d ? spreadChartHtml(d, animate) : '<div class="spread-chart loading" aria-busy="true"><i class="skeleton"></i></div>';
  const tl = d?.timeline || [];
  const showAll = state.storyAll.has(sid);
  const rows = (showAll ? tl : tl.slice(0, 10)).map((e, i) => {
    const h = e.platform === 'web' ? e.host : PLATFORM_HOST[e.platform] || e.host;
    const via = e.discussion && (e.platform === 'hn' || e.platform === 'reddit') ? `<a class="via" href="${esc(e.discussion)}" target="_blank" rel="noopener">discussion</a>` : '';
    return `<li style="--i:${Math.min(i, 12)}"${i === 0 ? ' class="first"' : ''}><span class="st-when" title="${esc(new Date(e.at).toLocaleString())}">${i === 0 ? 'First' : sinceLabel(e.at - first)}</span>
      <img src="${esc(e.avatar || fav(h))}" alt="" width="18" height="18" loading="lazy">
      <span class="st-body"><b>${esc(e.name)}</b> <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>${via}</span></li>`;
  }).join('');
  const spread = `<section class="story-card story-spread"><h2>How it spread <small>${d ? `${tl.length} ${tl.length === 1 ? 'outlet' : 'outlets'}${d.growth.length > tl.length ? ` and ${d.growth.length - tl.length} on X` : ''}` : 'loading…'}</small></h2>${chart}
    ${rows ? `<ol class="st-list${animate ? ' animate' : ''}">${rows}</ol>` : ''}
    ${tl.length > 10 ? `<button class="more st-more" type="button" data-storyall="${esc(sid)}">${showAll ? 'Show fewer' : `Show all ${tl.length}`}</button>` : ''}</section>`;

  const reactions = d?.reactions?.length ? `<section><h2>On X</h2><ul class="st-x">${d.reactions.map((r) => `<li><img src="${esc(r.avatar || fav('x.com'))}" alt="" width="28" height="28" loading="lazy" data-fallback="remove">
    <div><a class="who" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>${r.at ? ` <span>${time(r.at)}</span>` : ''}<p>${esc(r.title)}</p></div></li>`).join('')}</ul></section>` : '';
  const markets = d?.markets?.length ? `<section><h2>Markets</h2><ul class="st-markets">${d.markets.map((m) => storyMarketHtml(m, first)).join('')}</ul></section>` : '';
  const background = d?.background?.length ? `<section><h2>Background <small>earlier coverage</small></h2><ul class="topic-live">${d.background.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><span class="tl-meta"><img src="${esc(fav(r.site))}" alt="" loading="lazy" width="14" height="14">${esc(r.source || r.site)}${r.publishedAt ? ` · ${new Date(r.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</span></li>`).join('')}</ul></section>` : '';
  const side = reactions + markets + background || (d ? '' : '<section aria-busy="true"><i class="skeleton"></i><i class="skeleton"></i><i class="skeleton"></i></section>');

  setHtml($('#storyView'), `
    <header class="topic-head story-head${image ? ' has-image' : ''}">
      <div>
        <a class="back" href="#news">← News</a>
        <p class="kicker">${status}${entities.length ? ` · ${entities.map((k) => `<a href="#topic/${esc(k)}">${esc(topicName(k))}</a>`).join(', ')}` : ''}</p>
        <h1><a href="${esc(lead?.url || d?.url || live?.url)}" target="_blank" rel="noopener">${esc(title)}</a></h1>
        ${summary && summary !== title && !isUrlOnly(summary) ? `<p class="story-dek">${esc(summary)}</p>` : ''}
        <p class="topic-sum">${meta}</p>
        <button class="chip story-share" type="button" data-share="${esc(sid)}">Copy link</button>
      </div>
      ${image ? `<img class="story-hero" src="${esc(image)}" alt="" loading="lazy" data-fallback="remove">` : ''}
    </header>
    <div class="topic-grid story-grid">
      <div class="story-main">${brief}${spread}</div>
      <aside class="topic-side">${side}</aside>
    </div>`);
  loadStory(sid);
}

// ---------- This week (weekly digest) ----------

async function loadWeek() {
  const hit = state.week;
  if (state.mode !== 'api' || (hit && (hit.pending || Date.now() - hit.at < 5 * 60e3))) return;
  state.week = { ...hit, pending: true };
  let data = hit?.data || null;
  let error = null;
  try {
    const res = await fetch('api/digest');
    const body = await res.json();
    if (res.ok) data = body;
    else error = body.error;
  } catch (e) {
    error = e.message;
  }
  state.week = { at: Date.now(), data, error };
  if (state.view === 'week') renderWeek();
}

const weekRange = (d) => {
  const a = new Date(d.from), b = new Date(d.to);
  const same = a.getMonth() === b.getMonth();
  return `${a.toLocaleDateString('en', { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString('en', same ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
};
const ppChange = (now, before) => {
  const pp = (now - before) * 100;
  if (Math.abs(pp) < 0.5) return '';
  return `<span class="wk-delta ${pp > 0 ? 'up' : 'down'}" title="Share of stories, against the week before">${pp > 0 ? '▲' : '▼'} ${Math.abs(pp).toFixed(1)} pts</span>`;
};

function weekStoryHtml(s, i, max) {
  const meta = `<span class="tl-meta"><img src="${esc(fav(s.host))}" alt="" loading="lazy" width="14" height="14">${esc(s.source)} · ${dayLabel(new Date(s.at).toISOString().slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' })}</span>`;
  const cover = `<span class="wk-cover" title="${esc(s.names.join(', '))}${s.sources > s.names.length ? ' and more' : ''}"><span class="wk-bar"><i style="transform:scaleX(${(s.sources / max).toFixed(3)})"></i></span><b>${s.sources}</b> sources</span>`;
  if (i === 0) {
    return `<li class="wk-lead" data-id="${esc(s.id)}" style="--i:0">
      ${s.image ? `<img class="wk-img" src="${esc(s.image)}" alt="" loading="lazy" data-fallback="remove">` : ''}
      <div><span class="wk-rank">1</span><a class="wk-title" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${meta}${cover}</div>
    </li>`;
  }
  return `<li data-id="${esc(s.id)}" style="--i:${Math.min(i, 12)}"><span class="wk-rank">${i + 1}</span>
    <div><a class="wk-title" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${meta}${cover}</div></li>`;
}

let weekShown = 0;
function renderWeek() {
  const entry = state.week;
  const d = entry?.data;
  document.title = `This week · ${state.data?.site?.name || 'Frontier Wire'}`;
  const animate = !!d && weekShown !== d.generatedAt && !reducedMotion();
  if (d) weekShown = d.generatedAt;

  const sum = d
    ? `${weekRange(d)} · ${d.totals.stories.toLocaleString()} stories from ${d.totals.outlets.toLocaleString()} sources`
    : entry?.error ? `The digest is unavailable: ${esc(entry.error)}` : state.mode === 'api' ? 'Putting the week together…' : 'The digest needs the live server.';
  const max = d?.top[0]?.sources || 1;
  const top = d?.top.length ? `<ol class="wk-top${animate ? ' animate' : ''}">${d.top.map((s, i) => weekStoryHtml(s, i, max)).join('')}</ol>` : d ? '<p class="rail-note">Not enough coverage stored yet.</p>' : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>';
  const days = d?.byDay.length ? `<ol class="wk-days${animate ? ' animate' : ''}">${[...d.byDay].reverse().map((x, i) => `<li style="--i:${i}">
      <time datetime="${x.day}"><b>${dayLabel(x.day, { weekday: 'short' })}</b>${dayLabel(x.day, { day: 'numeric' })}</time>
      <div>${x.top ? `<a href="${esc(x.top.url)}" target="_blank" rel="noopener">${esc(x.top.title)}</a>` : ''}<span class="tl-meta">${x.top ? `${esc(x.top.source)} · ${x.top.sources} sources · ` : ''}${x.stories.toLocaleString()} stories that day</span></div></li>`).join('')}</ol>` : '';

  const tmax = d?.topics[0]?.n || 1;
  const topics = d?.topics.length ? `<ol class="wk-topics${animate ? ' animate' : ''}">${d.topics.map((t, i) => `<li style="--i:${i}"><a href="#topic/${esc(t.key)}">
      <span class="wk-tname">${esc(t.label)}</span><span class="wk-tn">${t.n.toLocaleString()}${t.prevShare != null ? ppChange(t.share, t.prevShare) : ''}</span>
      <span class="wk-bar"><i style="transform:scaleX(${(t.n / tmax).toFixed(3)})"></i></span></a></li>`).join('')}</ol>` : '';
  const markets = d?.markets?.length ? `<ul class="topic-markets">${d.markets.map((m) => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>
      <span class="tm-row">${oddsSpark(m.spark, 'mini')}${pct(m.from)} → <b>${pct(m.to)}</b>${m.binary ? '' : ` ${esc(m.label)}`}<span class="chg ${m.change > 0 ? 'up' : 'down'}">${m.change > 0 ? '+' : '−'}${Math.abs(Math.round(m.change * 100))} pts</span></span></li>`).join('')}</ul>` : '';
  const since = Date.now() - 7 * 86400e3;
  const releases = (state.data?.releases || []).filter((r) => r.date >= since).sort((a, b) => (b.notable ? 1 : 0) - (a.notable ? 1 : 0) || b.date - a.date);
  const rel = releases.length ? `<ul class="wk-rel">${releases.slice(0, 6).map((r) => `<li><img src="${esc(releaseLogo(r))}" alt="" width="18" height="18" loading="lazy"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a><time datetime="${new Date(r.date).toISOString()}">${shortDate(r.date)}</time></li>`).join('')}</ul>${releases.length > 6 ? `<a class="rail-link" href="#releases">All ${releases.length} this week</a>` : ''}` : '';

  setHtml($('#weekView'), `
    <header class="topic-head wk-head">
      <div>
        <p class="kicker">Weekly digest</p>
        <h1>The week in AI</h1>
        <p class="topic-sum">${sum}</p>
      </div>
      <a class="wk-rss" href="digest.xml" title="Subscribe to the week's biggest stories">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="15" r="2" fill="currentColor"/><path d="M3 9a8 8 0 0 1 8 8M3 3a14 14 0 0 1 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>RSS</a>
    </header>
    <div class="topic-grid">
      <div class="wk-main">
        <section class="topic-timeline"><h2>Biggest stories <small>by how many sources covered them</small></h2>${top}</section>
        ${days ? `<section class="topic-timeline"><h2>Day by day</h2>${days}</section>` : ''}
      </div>
      <aside class="topic-side">
        ${topics ? `<section><h2>Most covered <small>stories</small></h2>${topics}</section>` : ''}
        ${markets ? `<section><h2>Markets that moved</h2>${markets}</section>` : ''}
        ${rel ? `<section><h2>Released this week</h2>${rel}</section>` : ''}
      </aside>
    </div>`);
  loadWeek();
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
  $('#railMarkets').closest('.rail-block').hidden = !site.showMarkets;
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
  if (state.view === 'topic') renderTopic();
  if (state.view === 'week') renderWeek();
  if (state.view === 'story') renderStory();
  if (state.view === 'theme') renderTheme();
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
  const theme = /^theme\/([\w-]{6,16})$/.exec(v);
  if (theme) {
    state.themeId = theme[1];
    state.view = 'theme';
    const go = () => { render(); window.scrollTo({ top: 0 }); };
    return state.data ? transition(go) : go();
  }
  const story = /^story\/([\w-]{6,16})$/.exec(v);
  if (story) {
    state.storyId = story[1];
    state.view = 'story';
    const go = () => { render(); window.scrollTo({ top: 0 }); };
    return state.data ? transition(go) : go();
  }
  const topic = /^topic\/([a-z0-9]+)$/.exec(v);
  if (topic) {
    state.topicKey = topic[1];
    state.view = 'topic';
    const go = () => { render(); window.scrollTo({ top: 0 }); };
    return state.data ? transition(go) : go();
  }
  state.view = ['news', 'x', 'tech', 'week', 'releases', 'builds', 'markets'].includes(v) ? v : 'news';
  const name = state.data?.site?.name || 'Frontier Wire';
  document.title = { news: name, x: `On X · ${name}`, tech: `Tech · ${name}`, week: `This week · ${name}`, releases: `AI releases · ${name}`, builds: `Built with AI · ${name}`, markets: `AI markets · ${name}` }[state.view];
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
  else if (d.chartToggle) toggleChart(d.chartToggle);
  else if (d.storyall) {
    state.storyAll.has(d.storyall) ? state.storyAll.delete(d.storyall) : state.storyAll.add(d.storyall);
    transition(renderStory);
  }
  else if (d.share) {
    const url = `${location.origin}${location.pathname}#story/${d.share}`;
    (navigator.share && matchMedia('(pointer: coarse)').matches ? navigator.share({ url }) : navigator.clipboard.writeText(url))
      .then(() => { t.textContent = 'Copied'; setTimeout(() => (t.textContent = 'Copy link'), 1600); })
      .catch(() => {});
  }
  else if (d.relcov) {
    state.relCovOpen.has(d.relcov) ? state.relCovOpen.delete(d.relcov) : state.relCovOpen.add(d.relcov);
    loadRelCov(d.relcov);
    transition(() => renderReleases());
    $(`[data-relcov="${CSS.escape(d.relcov)}"]`)?.focus();
  }
  else if (d.related) {
    state.relOpen.has(d.related) ? state.relOpen.delete(d.related) : state.relOpen.add(d.related);
    loadRelated(d.related);
    transition(render);
    $(`[data-related="${CSS.escape(d.related)}"]`)?.focus();
  }
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

$('#marketList').addEventListener('pointermove', chartHover);
$('#topicView').addEventListener('pointermove', topicHover);
$('#storyView').addEventListener('pointermove', spreadHover);
$('#storyView').addEventListener('pointerleave', spreadHover, true);
$('#topicView').addEventListener('pointerleave', topicHover, true);
$('#marketList').addEventListener('pointerleave', chartHover, true);
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
