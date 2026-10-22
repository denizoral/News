// Trends (#trends?q=a,b&r=1y): how much of the coverage mentions each term
// over time, as mentions per 1,000 stories. Peaks are numbered on the chart;
// clicking one, or any point, lists what was said then. Server side:
// src/index/trends.js.

import { lineChart, pointAt, showPoint, timeTicks, compact } from './charts.js';

const RANGES = [['30d', '30 days'], ['90d', '90 days'], ['1y', '1 year'], ['2y', '2 years']];
const COLORS = ['var(--s1c)', 'var(--s2c)', 'var(--s3c)', 'var(--s4c)'];
const PRESETS = [
  ['The labs', 'OpenAI, Anthropic, Google DeepMind, xAI'],
  ['Open models', 'Llama, Qwen, DeepSeek, Mistral'],
  ['Ideas', 'agents, "reasoning model", MCP, RAG'],
  ['Chips', 'Nvidia, AMD, TPU, Cerebras'],
  ['Policy', 'regulation, copyright, "AI Act"'],
];
const MAX = 4;

export function createTrends({ $, esc, setHtml, state, reducedMotion }) {
  const view = { terms: [], range: '1y', sel: null };
  const cache = new Map(); // range|terms -> { d, error, pending }
  const moments = new Map(); // term|from -> { docs, error }
  let chartMeta = null;
  let drawn = null;

  const key = () => `${view.range}|${view.terms.join(',').toLowerCase()}`;
  const href = (terms = view.terms, range = view.range) => `#trends${terms.length ? `?q=${encodeURIComponent(terms.join(','))}${range !== '1y' ? `&r=${range}` : ''}` : range !== '1y' ? `?r=${range}` : ''}`;
  const fmtDate = (t, bucket) => new Date(t).toLocaleDateString('en', bucket === 'week' ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const period = (t, bucket) => (bucket === 'week' ? `Week of ${fmtDate(t, bucket)}` : fmtDate(t, bucket));

  const splitTerms = (s) => {
    const out = [];
    for (const t of String(s).split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t.slice(0, 60));
    }
    return out.slice(0, MAX);
  };

  function route(hash) {
    const m = /^#trends(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.terms = splitTerms(p.get('q') || '');
    view.range = RANGES.some(([k]) => k === p.get('r')) ? p.get('r') : '1y';
    view.sel = null;
    return 'trends';
  }

  async function load() {
    const k = key();
    const hit = cache.get(k);
    if (!view.terms.length || hit?.pending || hit?.d || (hit?.error && Date.now() - hit.at < 20e3)) return;
    cache.set(k, { pending: true });
    try {
      const r = await fetch(`/api/trends?q=${encodeURIComponent(view.terms.join(','))}&range=${view.range}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(k, { d, at: Date.now() });
      if (cache.size > 30) cache.delete(cache.keys().next().value);
    } catch (err) {
      cache.set(k, { error: err.message, at: Date.now() });
    }
    if (state.view === 'trends') render();
  }

  async function loadMoment(d, i) {
    const step = d.bucket === 'week' ? 7 * 864e5 : 864e5;
    const from = d.terms[0].points[i][0];
    await Promise.all(d.terms.map(async (t) => {
      const k = `${t.label.toLowerCase()}|${from}|${step}`;
      if (moments.has(k)) return;
      moments.set(k, { pending: true });
      try {
        const r = await fetch(`/api/trends/moment?q=${encodeURIComponent(t.label)}&from=${from}&to=${from + step}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        moments.set(k, { docs: j.docs });
      } catch (err) {
        moments.set(k, { error: err.message });
      }
    }));
    if (state.view === 'trends') render();
  }

  function summary(d) {
    return `<ul class="tr-sum">${d.terms.map((t, si) => {
      const peak = t.peaks.slice().sort((a, b) => b.share - a.share)[0];
      const ch = t.change == null ? 'new' : t.change === 0 ? 'flat' : `${t.change > 0 ? '↑' : '↓'} ${Math.abs(t.change)}%`;
      return `<li style="--c:${COLORS[si]};--i:${si}">
        <span class="tr-name"><i class="sw"></i>${esc(t.label)}</span>
        <b>${compact(t.total)}</b><small>mentions</small>
        <span class="tr-ch ${t.change > 0 ? 'up' : t.change < 0 ? 'down' : ''}" title="Last four ${d.bucket === 'week' ? 'weeks' : 'days'} against the four before">${ch}</span>
        ${peak ? `<small class="tr-peak">Peak ${esc(fmtDate(peak.t, d.bucket))}</small>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }

  function chart(d, animate) {
    const xs = d.terms[0].points.map((p) => p[0]);
    const series = d.terms.map((t, si) => ({ key: t.label, label: t.label, color: COLORS[si], values: t.points.map((p) => p[1]) }));
    let n = 0;
    const marks = [];
    d.terms.forEach((t, si) => t.peaks.forEach((p) => {
      const i = xs.indexOf(p.t);
      if (i >= 0) marks.push({ s: si, i, n: ++n, aria: `Peak ${n}: ${t.label}, ${period(p.t, d.bucket)}` });
    }));
    const narrow = innerWidth < 640;
    const { svg, meta } = lineChart({
      id: 'trends', xs, series, marks, animate,
      W: narrow ? 380 : 760, H: narrow ? 260 : 300,
      endLabels: !narrow,
      xTicks: timeTicks(xs, { days: d.bucket === 'day' && d.terms[0].points.length <= 31, max: narrow ? 4 : 7 }),
      xFmt: (t) => new Date(t).toLocaleDateString('en', d.bucket === 'day' && xs.length <= 31 ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { month: 'short', ...(new Date(t).getUTCMonth() === 0 || t === xs[0] ? { year: '2-digit' } : {}), timeZone: 'UTC' }),
      yFmt: (v) => compact(v),
      label: `Mentions per 1,000 stories: ${d.terms.map((t) => t.label).join(', ')}`,
    });
    chartMeta = { meta, xs, d, marks };
    const legend = d.terms.length > 1 || narrow ? `<ul class="tr-legend">${d.terms.map((t, si) => `<li style="--c:${COLORS[si]}"><i class="sw"></i>${esc(t.label)}</li>`).join('')}</ul>` : '';
    return `<section class="topic-card tr-card"><h2>Mentions per 1,000 stories<small>${d.bucket === 'week' ? 'per week' : 'per day'}</small></h2>${legend}<div class="tr-plot">${svg}</div><p class="tr-hint">${marks.length ? 'Numbered circles are peaks. ' : ''}Click any point to see what was said then.</p></section>`;
  }

  function peaks(d) {
    let n = 0;
    const rows = [];
    d.terms.forEach((t, si) => t.peaks.forEach((p) => {
      n++;
      rows.push(`<li style="--c:${COLORS[si]}"><button type="button" class="tr-pk" data-trpt="${d.terms[0].points.findIndex((x) => x[0] === p.t)}" aria-label="Show peak ${n}">${n}</button>
        <div><p class="tr-when">${esc(t.label)} · ${esc(period(p.t, d.bucket))} · ${compact(p.share)} per 1,000</p>
        ${p.doc ? `<a href="${esc(p.doc.url)}" target="_blank" rel="noopener">${esc(p.doc.title)}</a> <small>${esc(p.doc.site)}</small>` : ''}</div></li>`);
    }));
    return rows.length ? `<section class="tr-peaks"><h2 class="when">Peaks<span>${rows.length}</span></h2><ol class="tr-pklist">${rows.join('')}</ol></section>` : '';
  }

  function moment(d) {
    if (view.sel == null || !d.terms[0].points[view.sel]) return '';
    const step = d.bucket === 'week' ? 7 * 864e5 : 864e5;
    const from = d.terms[0].points[view.sel][0];
    const cols = d.terms.map((t, si) => {
      const m = moments.get(`${t.label.toLowerCase()}|${from}|${step}`);
      const [, share, count] = t.points[view.sel];
      const body = !m || m.pending ? '<p class="rail-note">Loading…</p>' : m.error ? `<p class="rail-note">${esc(m.error)}</p>` : m.docs.length ? `<ol>${m.docs.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><small>${esc(x.site)}</small></li>`).join('')}</ol>` : '<p class="rail-note">No mentions then.</p>';
      return `<div class="tr-mcol" style="--c:${COLORS[si]}"><h3><i class="sw"></i>${esc(t.label)}<small>${count} ${count === 1 ? 'mention' : 'mentions'} · ${compact(share)} per 1,000</small></h3>${body}</div>`;
    }).join('');
    return `<section class="topic-card tr-moment" aria-live="polite"><div class="head-row"><h2>${esc(period(from, d.bucket))}</h2><button type="button" class="chip" data-trclose>Close</button></div><div class="tr-mcols">${cols}</div></section>`;
  }

  function table(d) {
    const head = `<tr><th scope="col">${d.bucket === 'week' ? 'Week of' : 'Day'}</th>${d.terms.map((t) => `<th scope="col">${esc(t.label)}</th>`).join('')}<th scope="col">All stories</th></tr>`;
    const rows = d.terms[0].points.map((p, i) => `<tr><th scope="row">${esc(fmtDate(p[0], d.bucket))}</th>${d.terms.map((t) => `<td>${compact(t.points[i][1])} <small>(${t.points[i][2]})</small></td>`).join('')}<td>${d.totals[i]}</td></tr>`).reverse().join('');
    return `<details class="tr-table"><summary>Show as a table</summary><div class="tr-scroll"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div><p class="rail-note">Mentions per 1,000 stories stored that ${d.bucket}; the count of mentions in brackets.</p></details>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `${view.terms.length ? `${view.terms.join(', ')} · ` : ''}Trends · ${name}`;
    const ranges = RANGES.map(([k, l]) => `<a href="${href(view.terms, k)}" aria-pressed="${view.range === k}">${l}</a>`).join('');
    const chips = view.terms.map((t, si) => `<button type="button" class="chip tr-chip" style="--c:${COLORS[si]}" data-trdrop="${si}" aria-label="Remove ${esc(t)}"><i class="sw"></i>${esc(t)}<span aria-hidden="true">×</span></button>`).join('');
    const head = `<header class="topic-head">
        <p class="kicker">Search</p>
        <h1>Trends</h1>
        <p class="topic-sum">How much of the coverage mentions each term, out of every story the wire has stored since 2024. Counted as mentions per 1,000 stories, so a line only rises when the share does.</p>
      </header>
      <form class="tr-form" data-trform role="search">
        <label class="visually-hidden" for="trInput">Terms to compare, separated by commas</label>
        <input id="trInput" name="q" type="search" autocomplete="off" spellcheck="false" placeholder="Up to four terms, e.g. agents, RAG" value="${esc(view.terms.join(', '))}">
        <button class="btn" type="submit">Compare</button>
      </form>
      <div class="md-bar">${chips ? `<div class="chips">${chips}</div>` : '<div></div>'}<nav class="seg seg-mode" aria-label="Period">${ranges}</nav></div>`;
    if (state.mode !== 'api') {
      setHtml($('#trendsView'), `${head}<p class="rail-note">Trends need the live server.</p>`);
      return;
    }
    if (!view.terms.length) {
      chartMeta = null;
      setHtml($('#trendsView'), `${head}<section class="tr-presets"><h2 class="when">Try</h2><ul>${PRESETS.map(([l, q]) => `<li><a href="${href(splitTerms(q))}"><b>${esc(l)}</b><span>${esc(q)}</span></a></li>`).join('')}</ul></section>`);
      return;
    }
    load();
    const hit = cache.get(key());
    if (!hit?.d) {
      chartMeta = null;
      setHtml($('#trendsView'), `${head}${hit?.error ? `<p class="rail-note">Trends are unavailable: ${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const d = hit.d;
    // Show the terms as typed; the server answers in lower case.
    d.terms.forEach((t, i) => { if (view.terms[i]?.toLowerCase() === t.label.toLowerCase()) t.label = view.terms[i]; });
    const animate = drawn !== d && !reducedMotion();
    drawn = d;
    setHtml($('#trendsView'), `${head}${summary(d)}${chart(d, animate)}${moment(d)}${peaks(d)}${table(d)}<div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
  }

  function select(i) {
    const d = cache.get(key())?.d;
    if (!d || i < 0) return;
    view.sel = view.sel === i ? null : i;
    if (view.sel != null) loadMoment(d, i);
    render();
    if (view.sel != null) requestAnimationFrame(() => $('#trendsView .tr-moment')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' }));
  }

  function onClick(t, e) {
    const ds = t.dataset;
    if (ds.trdrop != null) {
      location.hash = href(view.terms.filter((_, i) => i !== Number(ds.trdrop)));
      return true;
    }
    if (ds.trpt != null) { select(Number(ds.trpt)); return true; }
    if (ds.trclose != null) { view.sel = null; render(); return true; }
    return false;
  }

  // Clicks on the plot (not buttons or links) pick the nearest point.
  function onPlotClick(e) {
    const svg = e.target.closest?.('#trendsView svg.lc');
    if (!svg || !chartMeta) return;
    const mark = e.target.closest('.lc-mark');
    if (mark) return select(Number(mark.dataset.mark.split(':')[1]));
    select(pointAt(svg, chartMeta.meta, e.clientX));
  }

  function onSubmit(e) {
    if (!e.target.matches?.('[data-trform]')) return false;
    e.preventDefault();
    const terms = splitTerms(e.target.q.value);
    location.hash = href(terms);
    return true;
  }

  function hover(e) {
    const svg = $('#trendsView svg.lc');
    const tip = $('#trendsView .tr-tip');
    if (!svg || !chartMeta) return;
    const i = e.type === 'pointerleave' || !e.target.closest?.('svg.lc') ? -1 : pointAt(svg, chartMeta.meta, e.clientX);
    const { d } = chartMeta;
    const html = i < 0 ? '' : `<p class="tt-h">${esc(period(d.terms[0].points[i][0], d.bucket))}</p>${d.terms.map((t, si) => `<p><i class="sw" style="--c:${COLORS[si]}"></i>${esc(t.label)} <b>${compact(t.points[i][1])}</b> <small>${t.points[i][2]}</small></p>`).join('')}`;
    showPoint(svg, chartMeta.meta, i, tip, $('#trendsView'), html, setHtml);
  }

  // Keyboard: arrows on a focused peak marker open its moment.
  function onKey(e) {
    const mark = e.target.closest?.('#trendsView .lc-mark');
    if (mark && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(Number(mark.dataset.mark.split(':')[1]));
      return true;
    }
    return false;
  }

  return { route, render, onClick, onPlotClick, onSubmit, hover, onKey, href: (terms) => href(splitTerms(terms.join(','))) };
}
