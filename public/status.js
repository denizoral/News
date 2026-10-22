// Status (#status): every source the wire reads, hour by hour — uptime
// strips, what arrived, what the spider did, server vitals and which X
// accounts have gone quiet. Server side: src/status.js (/api/health).

import { lineChart, barChart, pointAt, showPoint, timeTicks, compact } from './charts.js';

const HOURS = [[24, '24 hours'], [48, '48 hours'], [168, '7 days']];
const HOUR = 3600e3;
const SPIDER = [
  ['Indexed', 'var(--s1c)', ['indexed', 'updated']],
  ['Unchanged or skipped', 'var(--s3c)', ['not-modified', 'skipped', 'duplicate']],
  ['Blocked or failed', 'var(--s2c)', ['blocked', 'error']],
];
const VITALS = [
  ['api_p95', 'API response time, 95th percentile', (v) => `${Math.round(v)} ms`],
  ['loop_p99', 'Event-loop delay, 99th percentile', (v) => `${Math.round(v)} ms`],
  ['rss_mb', 'Server memory', (v) => `${Math.round(v)} MB`],
  ['embed_backlog', 'Waiting for embeddings', (v) => compact(v)],
];
const ICON = {
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l7 12.5H1z"/><path d="M8 6v3.6M8 11.6v.1" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  paused: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M6.3 5v6M9.7 5v6" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

export function createStatus({ $, esc, setHtml, state, reducedMotion, labels = {} }) {
  const view = { hours: 48 };
  const data = new Map(); // hours -> { d, at, error, pending }
  const charts = new Map(); // chart id -> { meta, tip(i) }
  let drawn = null;

  const label = (k) => labels[k] || k;
  const ago = (t) => {
    if (!t) return 'never';
    const m = Math.round((Date.now() - t) / 60e3);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const secs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(ms < 1e4 ? 1 : 0)} s`);
  const hourLabel = (t, long = false) => new Date(t).toLocaleString('en', long ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });

  function route(hash) {
    const m = /^#status(?:\?h=(\d+))?$/.exec(hash);
    if (!m) return null;
    view.hours = HOURS.some(([h]) => h === Number(m[1])) ? Number(m[1]) : 48;
    return 'status';
  }

  async function load() {
    const hit = data.get(view.hours);
    if (hit?.pending || (hit?.d && Date.now() - hit.at < 60e3) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    data.set(view.hours, { ...hit, pending: true });
    try {
      const r = await fetch(`/api/health?hours=${view.hours}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data.set(view.hours, { d, at: Date.now() });
    } catch (err) {
      data.set(view.hours, { ...hit, pending: false, error: err.message, at: Date.now() });
    }
    if (state.view === 'status') render();
  }

  const stateOf = (s) => (s.paused ? 'paused' : s.ok === false ? 'bad' : s.uptime != null && s.uptime < 90 ? 'warn' : 'good');
  const WORD = { good: 'Working', warn: 'Flaky', bad: 'Failing', paused: 'Paused' };

  // One cell per hour: no runs, all fine, some failed, all failed.
  function strip(s, d) {
    const cells = s.slots.map(([runs, fails, ms, added], i) => {
      const k = !runs ? 'none' : !fails ? 'good' : fails < runs ? 'warn' : 'bad';
      const t = d.from + i * HOUR;
      const tip = runs ? `${hourLabel(t, true)} · ${runs} ${runs === 1 ? 'run' : 'runs'}${fails ? `, ${fails} failed` : ''} · ${secs(ms)}${added ? ` · +${added} new` : ''}` : `${hourLabel(t, true)} · no runs`;
      return `<i class="ss-c ${k}" style="--i:${i}" data-tip="${esc(tip)}"></i>`;
    }).join('');
    return `<div class="ss-strip" style="--n:${s.slots.length || 1}" role="img" aria-label="${esc(`${label(s.name)}: ${s.uptime ?? '—'}% of runs succeeded`)}">${cells || '<i class="ss-c none"></i>'}</div>`;
  }

  function sources(d) {
    const rows = d.sources.map((s) => {
      const k = stateOf(s);
      return `<li class="ss-row ${k}">
        <div class="ss-name"><span class="ss-ic ${k}">${ICON[k]}</span><b>${esc(label(s.name))}</b><small>${WORD[k]}</small></div>
        ${strip(s, d)}
        <dl class="ss-nums"><div><dt>Runs ok</dt><dd>${s.uptime == null ? '—' : `${s.uptime}%`}</dd></div><div><dt>Median</dt><dd>${secs(s.p50)}</dd></div><div><dt>Last run</dt><dd>${ago(s.lastRun)}</dd></div></dl>
        ${s.lastError ? `<details class="ss-err"><summary>Last error ${ago(s.lastErrorAt)}</summary><code>${esc(s.lastError)}</code></details>` : ''}
      </li>`;
    }).join('');
    const ticks = timeTicks(Array.from({ length: d.slots }, (_, i) => d.from + i * HOUR), { days: true, max: 4 }).map((i) => `<span style="--at:${i / d.slots}">${esc(new Date(d.from + i * HOUR).toLocaleDateString('en', { weekday: 'short', day: 'numeric' }))}</span>`).join('');
    return `<section class="ss-sources"><h2 class="when">Sources<span>${d.sources.length}</span></h2>
      <p class="ss-key"><span><i class="ss-c good"></i>All runs ok</span><span><i class="ss-c warn"></i>Some failed</span><span><i class="ss-c bad"></i>All failed</span><span><i class="ss-c none"></i>No runs</span></p>
      <ul class="ss-list">${rows}</ul><div class="ss-axis" aria-hidden="true">${ticks}</div></section>`;
  }

  function tiles(d) {
    const up = d.sources.filter((s) => stateOf(s) === 'good' || stateOf(s) === 'paused').length;
    const last = (k) => d.vitals[k]?.[d.vitals[k].length - 1]?.[1];
    const arrived = d.ingest.reduce((a, b) => a + b, 0);
    const quiet = d.x.filter((a) => !a.last || Date.now() - a.last > 3 * 864e5).length;
    const t = [
      [`${up}/${d.sources.length}`, 'sources working'],
      [compact(arrived), `documents in ${view.hours === 168 ? '7 days' : `${view.hours} hours`}`],
      [last('api_p95') != null ? `${Math.round(last('api_p95'))} ms` : '—', 'API, 95th percentile'],
      [`${d.x.length - quiet}/${d.x.length}`, 'X accounts posting'],
    ];
    return `<ul class="ss-tiles">${t.map(([v, l], i) => `<li style="--i:${i}"><b>${v}</b><span>${l}</span></li>`).join('')}</ul>`;
  }

  function chartCard(id, title, built, note = '') {
    return `<section class="topic-card ss-chart"><h2>${title}</h2>${note}<div class="ss-plot" data-plot="${id}">${built.svg}</div></section>`;
  }

  function arrivals(d, animate) {
    const xs = Array.from({ length: d.slots }, (_, i) => d.from + i * HOUR);
    const narrow = innerWidth < 640;
    const xFmt = (t) => new Date(t).toLocaleDateString('en', { weekday: 'short', day: 'numeric' });
    const docs = barChart({ id: 'ingest', xs, stacks: [{ key: 'n', label: 'Documents', color: 'var(--s1c)', values: d.ingest }], W: narrow ? 380 : 720, H: 170, xFmt, xTicks: timeTicks(xs, { days: true, max: narrow ? 3 : 7 }), animate, label: 'Documents arriving per hour' });
    charts.set('ingest', { meta: docs.meta, tip: (i) => `<p class="tt-h">${esc(hourLabel(xs[i], true))}</p><p><b>${d.ingest[i]}</b> documents</p>` });
    const stacks = SPIDER.map(([l, c, kinds]) => ({ key: l, label: l, color: c, values: d.spider.map((h) => kinds.reduce((a, k) => a + (h[k] || 0), 0)) }));
    const sp = barChart({ id: 'spider', xs, stacks, W: narrow ? 380 : 720, H: 170, xFmt, xTicks: timeTicks(xs, { days: true, max: narrow ? 3 : 7 }), animate, label: 'Spider fetches per hour by outcome' });
    charts.set('spider', { meta: sp.meta, tip: (i) => `<p class="tt-h">${esc(hourLabel(xs[i], true))}</p>${stacks.map((s) => `<p><i class="sw" style="--c:${s.color}"></i>${s.label} <b>${s.values[i]}</b></p>`).join('')}` });
    const legend = `<ul class="tr-legend">${SPIDER.map(([l, c]) => `<li style="--c:${c}"><i class="sw"></i>${l}</li>`).join('')}</ul>`;
    return `<div class="ss-pair">${chartCard('ingest', 'Documents arriving per hour', docs)}${chartCard('spider', 'Spider fetches per hour', sp, legend)}</div>`;
  }

  function vitals(d, animate) {
    const cards = VITALS.map(([k, title, fmt]) => {
      const pts = d.vitals[k] || [];
      if (pts.length < 2) return `<section class="topic-card ss-chart ss-small"><h2>${title}</h2><p class="rail-note">Collecting: one sample every five minutes.</p></section>`;
      const xs = pts.map((p) => p[0]);
      const vals = pts.map((p) => p[1]);
      const c = lineChart({ id: `v-${k}`, xs, series: [{ key: k, label: title, color: 'var(--s1c)', values: vals }], W: 360, H: 150, endLabels: false, animate, xTicks: timeTicks(xs, { days: true, max: 3 }), xFmt: (t) => new Date(t).toLocaleDateString('en', { weekday: 'short', day: 'numeric' }), label: title });
      charts.set(`v-${k}`, { meta: c.meta, tip: (i) => `<p class="tt-h">${esc(hourLabel(xs[i], true))}</p><p><b>${fmt(vals[i])}</b></p>` });
      return `<section class="topic-card ss-chart ss-small"><h2>${title}<small>now ${fmt(vals[vals.length - 1])}</small></h2><div class="ss-plot" data-plot="v-${k}">${c.svg}</div></section>`;
    }).join('');
    return `<h2 class="when">Server</h2><div class="ss-vitals">${cards}</div>`;
  }

  function xAccounts(d) {
    const items = d.x.map((a) => {
      const quiet = !a.last || Date.now() - a.last > 3 * 864e5;
      return `<li class="${quiet ? 'quiet' : ''}"><a href="#account/${esc(a.handle)}">@${esc(a.handle)}</a><span>${quiet ? `<span class="ss-ic warn">${ICON.warn}</span>` : ''}${a.last ? `last post ${ago(a.last)}` : 'no posts in 30 days'}</span><small>${a.week} this week</small></li>`;
    }).join('');
    return `<section class="ss-x"><h2 class="when">X accounts<span>${d.x.length}</span></h2><p class="rail-note">Quietest first. Three days without a post is flagged: the handle may have moved or stopped posting.</p><ul>${items}</ul></section>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `Status · ${name}`;
    const seg = HOURS.map(([h, l]) => `<a href="#status${h === 48 ? '' : `?h=${h}`}" aria-pressed="${view.hours === h}">${l}</a>`).join('');
    if (state.mode !== 'api') {
      setHtml($('#statusView'), '<header class="topic-head"><p class="kicker">Status</p><h1>Status</h1><p class="topic-sum">The status page needs the live server.</p></header>');
      return;
    }
    load();
    const hit = data.get(view.hours);
    const d = hit?.d;
    const bad = d ? d.sources.filter((s) => stateOf(s) === 'bad') : [];
    const flaky = d ? d.sources.filter((s) => stateOf(s) === 'warn') : [];
    const k = !d ? 'good' : bad.length ? 'bad' : flaky.length ? 'warn' : 'good';
    const headline = !d ? 'Status' : bad.length ? `${bad.length} ${bad.length === 1 ? 'source is' : 'sources are'} failing` : flaky.length ? `${flaky.length} ${flaky.length === 1 ? 'source is' : 'sources are'} flaky` : 'Everything is working';
    const head = `<header class="topic-head ss-head">
        <div class="head-row"><p class="kicker">Status</p><nav class="seg seg-mode" aria-label="Period">${seg}</nav></div>
        <h1>${d ? `<span class="ss-ic big ${k}">${ICON[k]}</span>` : ''}${esc(headline)}</h1>
        <p class="topic-sum">Every source the wire reads, hour by hour.${d ? ` ${bad.concat(flaky).map((s) => esc(label(s.name))).join(', ')}${bad.length || flaky.length ? '.' : ''} Updated ${ago(hit.at)}.` : ''}</p>
      </header>`;
    if (!d) {
      setHtml($('#statusView'), `${head}${hit?.error ? `<p class="rail-note">Status is unavailable: ${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const animate = drawn !== d && !reducedMotion();
    drawn = d;
    charts.clear();
    setHtml($('#statusView'), `${head}${tiles(d)}${sources(d)}${arrivals(d, animate)}${vitals(d, animate)}${xAccounts(d)}<div class="ac-tip ss-tip" role="tooltip" hidden></div>`);
  }

  function hover(e) {
    const host = $('#statusView');
    const tip = host?.querySelector('.ss-tip');
    if (!tip) return;
    const cell = e.type !== 'pointerleave' && e.target.closest?.('.ss-c[data-tip]');
    host.querySelectorAll('svg.lc').forEach((svg) => { if (!svg.contains(e.target)) showPoint(svg, charts.get(svg.dataset.chart)?.meta || { xPos: [] }, -1, null); });
    if (cell) {
      tip.textContent = cell.dataset.tip;
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const r = cell.getBoundingClientRect();
      const x = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, r.left - box.left + r.width / 2 - tip.offsetWidth / 2));
      tip.style.transform = `translate(${x}px, ${r.top - box.top - tip.offsetHeight - 8}px)`;
      return;
    }
    const svg = e.type !== 'pointerleave' && e.target.closest?.('#statusView svg.lc');
    const c = svg && charts.get(svg.dataset.chart);
    if (!c) { tip.hidden = true; return; }
    const i = pointAt(svg, c.meta, e.clientX);
    showPoint(svg, c.meta, i, tip, host, i < 0 ? '' : c.tip(i), setHtml);
  }

  return { route, render, hover };
}
