// Outlets (#outlets, #outlet/<site>): every outlet with steady AI coverage,
// and a profile per outlet: a year of weekly volume, its beat (the companies
// and themes it names more than all outlets do), when it publishes, its
// writers, outlets with a similar beat and its latest headlines.
// Server side: src/index/outlets.js.

import { barChart, pointAt, showPoint } from './charts.js';

const SORTS = [['ai', 'Most AI articles'], ['share', 'Most about AI'], ['words', 'Longest reads']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PAGE = 40;
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const fullDay = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const hourLabel = (h) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

// A 13-week sparkline: 2px line, last point marked.
function spark(weeks) {
  const W = 88, H = 24, max = Math.max(1, ...weeks);
  const pts = weeks.map((v, i) => [(i / (weeks.length - 1)) * (W - 4) + 2, H - 3 - (v / max) * (H - 6)]);
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="ol-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5"/></svg>`;
}

export function createOutlets({ $, esc, setHtml, state, reducedMotion, followBtn }) {
  const view = { site: null, sort: 'ai', find: '', shown: PAGE };
  let dir = null; // { d, error, pending, at }
  const profiles = new Map(); // site -> { d, error, pending, at }
  let charts = {};
  let drawn = null;

  const href = (site) => (site ? `#outlet/${encodeURIComponent(site)}` : '#outlets');

  function route(hash) {
    if (hash === '#outlets') {
      view.site = null;
      return 'outlets';
    }
    const m = /^#outlet\/([a-z0-9.-]{3,80})$/i.exec(hash);
    if (!m) return null;
    view.site = m[1].toLowerCase();
    return 'outlets';
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }

  async function loadDir() {
    if (dir?.pending || dir?.d || (dir?.error && Date.now() - dir.at < 20e3)) return;
    dir = { pending: true };
    try {
      dir = { d: await fetchJson('/api/outlets'), at: Date.now() };
    } catch (err) {
      dir = { error: err.message, at: Date.now() };
    }
    if (state.view === 'outlets') render();
  }

  async function loadSite(site) {
    const hit = profiles.get(site);
    if (hit?.pending || hit?.d || (hit?.error && Date.now() - hit.at < 20e3)) return;
    profiles.set(site, { pending: true });
    try {
      profiles.set(site, { d: await fetchJson(`/api/outlet?site=${encodeURIComponent(site)}`), at: Date.now() });
    } catch (err) {
      profiles.set(site, { error: err.message, at: Date.now() });
    }
    if (state.view === 'outlets' && view.site === site) render();
  }

  // ---- Directory ----

  function directory(d) {
    const needle = view.find.trim().toLowerCase();
    let rows = d.outlets.filter((o) => !needle || o.name.toLowerCase().includes(needle) || o.site.includes(needle) || o.beat.some((b) => b.label.toLowerCase().includes(needle)));
    if (view.sort === 'share') rows = rows.slice().sort((a, b) => b.aiShare - a.aiShare || b.ai - a.ai);
    if (view.sort === 'words') rows = rows.slice().sort((a, b) => (b.words || 0) - (a.words || 0));
    const sorts = SORTS.map(([k, l]) => `<button type="button" class="chip" data-olsort="${k}" aria-pressed="${view.sort === k}">${l}</button>`).join('');
    const items = rows.slice(0, view.shown).map((o, i) => `<li style="--i:${Math.min(i, 20)}">
      <a class="ol-row" href="${href(o.site)}">
        <img src="${esc(fav(o.site))}" alt="" width="20" height="20" loading="lazy" data-fallback="remove">
        <span class="ol-name"><b>${esc(o.name)}</b><small>${esc(o.site)}</small></span>
        ${spark(o.weeks)}
        <span class="ol-num"><b>${o.perWeek}</b><small>a week</small></span>
        <span class="ol-share" title="${pct(o.aiShare)} of its articles are about AI"><i style="width:${pct(o.aiShare, 1)}"></i></span>
        <span class="ol-beat">${o.beat.map((b) => `<em>${esc(b.label)}</em>`).join('')}</span>
      </a></li>`).join('');
    return `<ul class="ss-tiles ol-tiles">
        <li style="--i:0"><b>${d.total}</b><span>outlets with 20+ AI articles</span></li>
        <li style="--i:1"><b>${d.articles.toLocaleString()}</b><span>AI articles in ${d.days} days</span></li>
      </ul>
      <section class="ol-dir">
        <div class="dl-tools"><h2 class="when">Outlets<span>${rows.length}</span></h2>
          <label class="visually-hidden" for="olFind">Filter outlets</label>
          <input id="olFind" type="search" placeholder="Outlet or beat, e.g. Nvidia" autocomplete="off" value="${esc(view.find)}">
          <div class="chips">${sorts}</div></div>
        <p class="ol-cols" aria-hidden="true"><span>Outlet</span><span>13 weeks</span><span>AI per week</span><span>Share about AI</span><span>Covers more than most</span></p>
        ${rows.length ? `<ol class="ol-list">${items}</ol>` : `<p class="rail-note">No outlet matches “${esc(view.find)}”.</p>`}
        ${rows.length > view.shown ? `<button type="button" class="more" data-olmore>Show ${Math.min(PAGE, rows.length - view.shown)} more</button>` : ''}
      </section>`;
  }

  // ---- Profile ----

  function beat(o) {
    if (!o.beat.length) return '<p class="rail-note">Its coverage matches the average outlet’s.</p>';
    const max = Math.max(...o.beat.map((b) => Math.max(b.share, b.base)));
    return `<ul class="tr-legend"><li style="--c:var(--s1c)"><i class="sw"></i>${esc(o.name)}</li><li class="ol-avg-key"><i class="ol-tick"></i>All outlets</li></ul>
      <ol class="ol-beat-list">${o.beat.map((b, i) => `<li style="--i:${i}">
        <a href="#topic/${esc(b.key)}">${esc(b.label)}</a>
        <span class="ol-track" title="${pct(b.share, 1)} of its AI articles, against ${pct(b.base, 1)} across all outlets"><i style="width:${((b.share / max) * 100).toFixed(1)}%"></i><b class="ol-tick" style="left:${((b.base / max) * 100).toFixed(1)}%"></b></span>
        <span class="ol-lift"><b>${b.lift >= 10 ? Math.round(b.lift) : b.lift.toFixed(1)}×</b><small>${pct(b.share, 1)} vs ${pct(b.base, 1)}</small></span></li>`).join('')}</ol>`;
  }

  function yearChart(o, animate) {
    const narrow = innerWidth < 640;
    const xs = o.year.weeks.map((_, i) => o.year.from + i * 7 * 86400e3);
    const ticks = xs.map((t, i) => i).filter((i) => i === 0 || new Date(xs[i]).getUTCMonth() !== new Date(xs[i - 1]).getUTCMonth()).filter((_, j, a) => a.length <= (narrow ? 4 : 12) || j % Math.ceil(a.length / (narrow ? 4 : 12)) === 0);
    const { svg, meta } = barChart({ id: 'olyear', xs, stacks: [{ key: 'n', label: 'Articles', color: 'var(--s1c)', values: o.year.weeks }], W: narrow ? 380 : 760, H: narrow ? 180 : 200, animate, xTicks: ticks, xFmt: (t) => new Date(t).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }), label: `${o.name}: articles per week over the last year` });
    charts.olyear = { meta, tip: (i) => `<p class="tt-h">Week of ${fullDay(xs[i])}</p><p><b>${o.year.weeks[i]}</b> articles</p>` };
    return svg;
  }

  function hoursChart(o, animate) {
    if (!o.hours) return '';
    const narrow = innerWidth < 640;
    const xs = o.hours.map((_, h) => h);
    const total = o.hours.reduce((a, b) => a + b, 0) || 1;
    const { svg, meta } = barChart({ id: 'olhours', xs, stacks: [{ key: 'n', label: 'Articles', color: 'var(--s1c)', values: o.hours }], W: narrow ? 380 : 760, H: narrow ? 160 : 180, animate, xTicks: [0, 6, 12, 18, 23], xFmt: (h) => hourLabel(h), label: `${o.name}: AI articles by hour of day (UTC)` });
    charts.olhours = { meta, tip: (i) => `<p class="tt-h">${hourLabel(i)}–${hourLabel((i + 1) % 24)} UTC</p><p><b>${o.hours[i]}</b> articles · ${pct(o.hours[i] / total)}</p>` };
    return svg;
  }

  function profile(o, animate) {
    const t = o.totals;
    charts = {};
    const tiles = [
      [t.ai.toLocaleString(), `AI articles in ${o.days} days`],
      [t.perWeek, 'a week'],
      [pct(t.aiShare), 'of its articles are about AI'],
      [o.words ? o.words.toLocaleString() : '—', 'words in a typical article'],
    ];
    const wmax = Math.max(1, ...o.weekdays);
    const weekdays = `<ol class="ol-days" aria-label="AI articles by day of the week">${o.weekdays.map((n, i) => `<li title="${n} articles"><span><i style="height:${((n / wmax) * 100).toFixed(1)}%;--i:${i}"></i></span><small>${WEEKDAYS[i]}</small></li>`).join('')}</ol>`;
    const covered = `<ol class="ol-covered">${o.covered.map((c) => `<li><a href="#topic/${esc(c.key)}">${esc(c.label)}</a><small>${pct(c.share)}</small></li>`).join('')}</ol>`;
    const similar = o.similar.length ? `<section class="dy-side"><h2 class="when">Similar beat</h2><ul class="ol-similar">${o.similar.map((s) => `<li><a href="${href(s.site)}"><img src="${esc(fav(s.site))}" alt="" width="16" height="16" loading="lazy" data-fallback="remove">${esc(s.name)}</a><small>${s.ai} AI articles</small></li>`).join('')}</ul></section>` : '';
    const authors = o.authors.length ? `<section class="dy-side"><h2 class="when">Writers</h2><ul class="ol-authors">${o.authors.map((a) => `<li><a href="#search?q=${encodeURIComponent(`site:${o.site} "${a.name}"`)}">${esc(a.name)}</a><small>${a.n}</small></li>`).join('')}</ul></section>` : '';
    const latest = `<section class="dy-side"><h2 class="when">Latest</h2><ul class="dy-list">${o.latest.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a><small>${fullDay(l.at)}${l.author ? ` · ${esc(l.author)}` : ''}</small></li>`).join('')}</ul></section>`;
    return `<header class="topic-head ol-head">
        <p class="kicker"><a href="#outlets">Outlets</a></p>
        <div class="ol-title"><img src="${esc(fav(o.site))}" alt="" width="32" height="32" data-fallback="remove"><h1>${esc(o.name)}</h1></div>
        <p class="topic-sum"><a href="https://${esc(o.site)}" target="_blank" rel="noopener">${esc(o.site)}</a> · ${t.lifetime.toLocaleString()} articles stored${t.since ? ` since ${new Date(t.since).getUTCFullYear()}` : ''}</p>
        <div class="ol-btns">${followBtn('outlet', o.name, o.name)}<a class="chip" href="#search?q=${encodeURIComponent(`site:${o.site}`)}">Search its articles</a></div>
      </header>
      <ul class="ss-tiles">${tiles.map(([b, s], i) => `<li style="--i:${i}"><b>${b}</b><span>${s}</span></li>`).join('')}</ul>
      <div class="dy-grid">
        <div>
          <section class="topic-card"><h2>Its beat<small>what it names more than all outlets do, last ${o.days} days</small></h2>${beat(o)}</section>
          <section class="topic-card"><h2>Articles per week<small>the last year, all subjects</small></h2><div class="tr-plot">${yearChart(o, animate)}</div></section>
          <section class="topic-card ol-when"><h2>When it publishes<small>AI articles, UTC</small></h2>
            ${o.hours ? `<div class="tr-plot">${hoursChart(o, animate)}</div>` : '<p class="rail-note">Its feed gives dates without times.</p>'}
            <h3 class="ol-sub">By day of the week</h3>${weekdays}</section>
          <section class="topic-card"><h2>Most covered<small>share of its AI articles</small></h2>${covered}</section>
        </div>
        <aside>${similar}${authors}${latest}</aside>
      </div>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    if (state.mode !== 'api') {
      setHtml($('#outletsView'), '<header class="topic-head"><h1>Outlets</h1></header><p class="rail-note">Outlets need the live server.</p>');
      return;
    }
    if (view.site) {
      loadSite(view.site);
      const hit = profiles.get(view.site);
      document.title = `${hit?.d?.name || view.site} · Outlets · ${name}`;
      if (!hit?.d) {
        setHtml($('#outletsView'), `<header class="topic-head"><p class="kicker"><a href="#outlets">Outlets</a></p><h1>${esc(view.site)}</h1></header>${hit?.error ? `<p class="rail-note">${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
        return;
      }
      const animate = drawn !== hit.d && !reducedMotion();
      drawn = hit.d;
      setHtml($('#outletsView'), `${profile(hit.d, animate)}<div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
      return;
    }
    document.title = `Outlets · ${name}`;
    loadDir();
    const head = `<header class="topic-head">
        <p class="kicker">Sources</p>
        <h1>Outlets</h1>
        <p class="topic-sum">Who covers AI, how much, and what each outlet covers more than the rest: its beat, when it publishes, its writers and the outlets most like it.</p>
      </header>`;
    if (!dir?.d) {
      setHtml($('#outletsView'), `${head}${dir?.error ? `<p class="rail-note">Outlets are unavailable: ${esc(dir.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const focused = document.activeElement?.id === 'olFind';
    setHtml($('#outletsView'), `${head}${directory(dir.d)}`);
    if (focused) {
      const el = $('#olFind');
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function onClick(t) {
    const ds = t.dataset;
    if (ds.olsort) { view.sort = ds.olsort; view.shown = PAGE; render(); return true; }
    if (ds.olmore != null) { view.shown += PAGE; render(); return true; }
    return false;
  }

  function onInput(e) {
    if (e.target.id !== 'olFind') return false;
    view.find = e.target.value;
    view.shown = PAGE;
    render();
    return true;
  }

  function hover(e) {
    const tip = $('#outletsView .tr-tip');
    for (const [id, c] of Object.entries(charts)) {
      const svg = $(`#outletsView svg[data-chart="${id}"]`);
      if (!svg) continue;
      const on = e.type !== 'pointerleave' && e.target.closest?.(`svg[data-chart="${id}"]`);
      const i = on ? pointAt(svg, c.meta, e.clientX) : -1;
      showPoint(svg, c.meta, i, tip, $('#outletsView'), i < 0 ? '' : c.tip(i), setHtml);
      if (on) return;
    }
  }

  return { route, render, onClick, onInput, hover };
}
