// Deals (#deals?r=1y&k=funding&c=<company>): funding rounds, valuations and
// acquisitions read from headlines. Capital raised per week or month by stage,
// the biggest raisers, every deal with its first report, and a panel per
// company with its valuation history. Server side: src/index/deals.js.

import { barChart, lineChart, pointAt, showPoint, timeTicks } from './charts.js';

const RANGES = [['90d', '90 days'], ['1y', '1 year'], ['2y', '2 years']];
const KINDS = [['all', 'All'], ['funding', 'Rounds'], ['acquisition', 'Acquisitions']];
const STAGES = [['seed', 'Seed', 'var(--s1c)'], ['early', 'Series A–B', 'var(--s2c)'], ['late', 'Series C and later', 'var(--s3c)'], ['unknown', 'Stage not given', 'var(--s4c)']];
const PAGE = 60;

// $1.2B, $550M, $3.5M, $600K.
export function money(v, fx = false) {
  if (v == null) return '—';
  const s = v >= 1e12 ? `$${+(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${+(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)}B` : v >= 1e6 ? `$${+(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M` : `$${Math.round(v / 1e3)}K`;
  return fx ? `≈${s}` : s;
}

export function createDeals({ $, esc, setHtml, state, reducedMotion }) {
  const view = { range: '1y', kind: 'all', sort: 'latest', co: null, find: '', shown: PAGE };
  const cache = new Map(); // range -> { d, error, pending, at }
  const companies = new Map(); // key -> { d, error, pending }
  let chartMeta = null;
  let drawn = null;
  let coMeta = null;
  let coDrawn = null;

  const href = (p = {}) => {
    const n = { range: view.range, kind: view.kind, co: view.co, ...p };
    const q = new URLSearchParams();
    if (n.range !== '1y') q.set('r', n.range);
    if (n.kind !== 'all') q.set('k', n.kind);
    if (n.co) q.set('c', n.co);
    return `#deals${q.toString() ? `?${q}` : ''}`;
  };
  const day = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fullDay = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  function route(hash) {
    const m = /^#deals(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    const range = RANGES.some(([k]) => k === p.get('r')) ? p.get('r') : '1y';
    if (range !== view.range) view.shown = PAGE;
    view.range = range;
    view.kind = KINDS.some(([k]) => k === p.get('k')) ? p.get('k') : 'all';
    view.co = /^[\p{L}\p{N}-]{1,60}$/u.test(p.get('c') || '') ? p.get('c') : null;
    return 'deals';
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }

  async function load() {
    const hit = cache.get(view.range);
    if (hit?.pending || hit?.d || (hit?.error && Date.now() - hit.at < 20e3)) return;
    cache.set(view.range, { pending: true });
    try {
      cache.set(view.range, { d: await fetchJson(`/api/deals?range=${view.range}`), at: Date.now() });
    } catch (err) {
      cache.set(view.range, { error: err.message, at: Date.now() });
    }
    if (state.view === 'deals') render();
  }

  async function loadCompany(key) {
    if (companies.has(key)) return;
    companies.set(key, { pending: true });
    try {
      companies.set(key, { d: await fetchJson(`/api/deals/company?key=${encodeURIComponent(key)}`) });
    } catch (err) {
      companies.set(key, { error: err.message });
    }
    if (state.view === 'deals') render();
  }

  function tiles(d) {
    const t = d.totals;
    const items = [
      [money(t.raised), `raised in ${t.rounds.toLocaleString()} ${t.rounds === 1 ? 'round' : 'rounds'}`],
      [t.biggest ? money(t.biggest.amount) : '—', t.biggest ? `largest: ${esc(t.biggest.company)}` : 'largest round'],
      [t.acquisitions.toLocaleString(), `acquisitions${t.acquisitionValue ? `, ${money(t.acquisitionValue)} disclosed` : ''}`],
      [t.talks.toLocaleString(), t.talks === 1 ? 'deal only in talks' : 'deals only in talks'],
    ];
    return `<ul class="ss-tiles dl-tiles">${items.map(([b, s], i) => `<li style="--i:${i}"><b>${b}</b><span>${s}</span></li>`).join('')}</ul>`;
  }

  function chart(d, animate) {
    const narrow = innerWidth < 640;
    const xs = d.buckets;
    const stacks = STAGES.map(([k, label, color]) => ({ key: k, label, color, values: d.raised[k] }));
    const monthly = d.unit === 'month';
    const { svg, meta } = barChart({
      id: 'deals', xs, stacks, animate,
      W: narrow ? 380 : 760, H: narrow ? 220 : 240,
      yFmt: (v) => (v ? money(v) : '0'),
      xTicks: timeTicks(xs, { days: !monthly, max: narrow ? 4 : 8 }),
      xFmt: (t) => new Date(t).toLocaleDateString('en', monthly ? { month: 'short', ...(new Date(t).getUTCMonth() === 0 || t === xs[0] ? { year: '2-digit' } : {}), timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      label: `Capital raised per ${d.unit} by stage`,
    });
    chartMeta = { meta, d };
    const legend = `<ul class="tr-legend">${STAGES.map(([, label, c]) => `<li style="--c:${c}"><i class="sw"></i>${label}</li>`).join('')}</ul>`;
    return `<section class="topic-card dl-card"><h2>Capital raised<small>per ${d.unit}, announced rounds</small></h2>${legend}<div class="tr-plot">${svg}</div></section>`;
  }

  function top(d) {
    if (!d.top.length) return '';
    const max = d.top[0].raised;
    return `<section class="dl-top"><h2 class="when">Raised the most</h2><ol>${d.top.map((c, i) => `<li style="--i:${i}">
      <button type="button" class="dl-co" data-dlco="${esc(c.key)}">${esc(c.company)}</button>
      <span class="dl-bar"><i style="width:${Math.max(2, (c.raised / max) * 100).toFixed(1)}%"></i></span>
      <b>${money(c.raised)}</b><small>${c.rounds} ${c.rounds === 1 ? 'round' : 'rounds'}${c.valuation ? ` · valued ${money(c.valuation)}` : ''}</small></li>`).join('')}</ol></section>`;
  }

  function kindLabel(x) {
    if (x.kind === 'acquisition') return `<span class="dl-kind buy">${x.acquirer ? `Bought by ${esc(x.acquirer)}` : 'Acquired'}</span>`;
    if (x.kind === 'valuation') return '<span class="dl-kind val">Valuation</span>';
    return `<span class="dl-kind">${esc(x.round || 'Round')}</span>`;
  }

  function row(x, i) {
    const amount = x.kind === 'valuation' ? money(x.valuation) : money(x.amount, x.fx);
    const sub = x.kind === 'funding' && x.valuation ? `at ${money(x.valuation)}` : x.kind === 'valuation' ? 'valuation' : x.kind === 'acquisition' && !x.amount ? 'price not given' : '';
    const more = x.outlets > 1 ? ` · ${x.outlets} outlets` : '';
    return `<li class="dl-row${x.talks ? ' talks' : ''}" style="--i:${Math.min(i, 20)}">
      <time datetime="${new Date(x.at).toISOString()}">${day(x.at)}</time>
      <div class="dl-main">
        <p><button type="button" class="dl-co" data-dlco="${esc(x.companyKey)}">${esc(x.company)}</button>${kindLabel(x)}${x.talks ? '<span class="dl-kind talk">In talks</span>' : ''}</p>
        <a class="dl-head" href="${esc(x.first.url)}" target="_blank" rel="noopener">${esc(x.first.title)}</a>
        <small>${esc(x.first.site)}${more}${x.investors.length ? ` · ${esc(x.investors.slice(0, 3).join(', '))}` : ''}</small>
      </div>
      <div class="dl-num"><b>${amount}</b>${sub ? `<small>${sub}</small>` : ''}</div>
    </li>`;
  }

  function list(d) {
    const needle = view.find.trim().toLowerCase();
    let rows = d.deals.filter((x) => (view.kind === 'all' || x.kind === view.kind || (view.kind === 'funding' && x.kind === 'valuation'))
      && (!needle || x.company.toLowerCase().includes(needle) || (x.acquirer || '').toLowerCase().includes(needle) || x.investors.some((v) => v.toLowerCase().includes(needle))));
    if (view.sort === 'largest') rows = rows.slice().sort((a, b) => (b.amount || b.valuation || 0) - (a.amount || a.valuation || 0));
    // Month headers in date order.
    let lastMonth = '';
    const items = rows.slice(0, view.shown).map((x, i) => {
      const m = new Date(x.at).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const head = view.sort === 'latest' && m !== lastMonth ? `<li class="dl-month">${m}</li>` : '';
      lastMonth = m;
      return head + row(x, i);
    }).join('');
    const sorts = [['latest', 'Latest'], ['largest', 'Largest']].map(([k, l]) => `<button type="button" class="chip" data-dlsort="${k}" aria-pressed="${view.sort === k}">${l}</button>`).join('');
    return `<section class="dl-list-wrap">
      <div class="dl-tools"><h2 class="when">Deals<span>${rows.length}</span></h2>
        <label class="visually-hidden" for="dlFind">Filter by company or investor</label>
        <input id="dlFind" type="search" placeholder="Company or investor" autocomplete="off" value="${esc(view.find)}">
        <div class="chips">${sorts}</div></div>
      ${rows.length ? `<ol class="dl-list">${items}</ol>` : `<p class="rail-note">No deals match${needle ? ` “${esc(view.find)}”` : ''}.</p>`}
      ${rows.length > view.shown ? `<button type="button" class="more" data-dlmore>Show ${Math.min(PAGE, rows.length - view.shown)} more</button>` : ''}
    </section>`;
  }

  function companyPanel() {
    if (!view.co) return '';
    loadCompany(view.co);
    const hit = companies.get(view.co);
    const close = `<a class="chip" href="${href({ co: null })}">Close</a>`;
    if (!hit?.d) return `<section class="topic-card dl-panel" aria-live="polite"><div class="head-row"><h2>${hit?.error ? 'Not found' : 'Loading…'}</h2>${close}</div>${hit?.error ? `<p class="rail-note">${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}</section>`;
    const c = hit.d;
    const vals = c.valuations;
    let chartHtml = '';
    if (vals.length >= 2) {
      const narrow = innerWidth < 640;
      const xs = vals.map((v) => v.at);
      const { svg, meta } = lineChart({ id: 'dealsco', xs, series: [{ key: 'v', label: 'Valuation', color: 'var(--s1c)', values: vals.map((v) => v.valuation) }], W: narrow ? 380 : 1000, H: narrow ? 200 : 220, endLabels: false, yFmt: (v) => (v ? money(v) : '0'), xTicks: xs.map((_, i) => i).filter((i, _, a) => a.length <= 6 || i % Math.ceil(a.length / 6) === 0), xFmt: (t) => new Date(t).toLocaleDateString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' }), animate: coDrawn !== c && !reducedMotion(), label: `${c.company} valuation over time` });
      coDrawn = c;
      coMeta = { meta, vals };
      chartHtml = `<h3 class="dl-sub">Valuation</h3><div class="tr-plot dl-coplot">${svg}</div>`;
    } else {
      coMeta = null;
    }
    if (vals.length === 1) {
      chartHtml = `<p class="dl-valone">Valued at <b>${money(vals[0].valuation)}</b> ${vals[0].round ? `in its ${esc(vals[0].round)}` : ''} (${fullDay(vals[0].at)})</p>`;
    }
    const deals = c.deals.slice().reverse();
    const timeline = deals.map((x) => {
      const what = x.kind === 'acquisition'
        ? (x.companyKey === c.key ? `Bought by ${esc(x.acquirer || '?')}` : `Bought ${esc(x.company)}`)
        : x.kind === 'valuation' ? `Valued at ${money(x.valuation)}` : `${esc(x.round || 'Round')}${x.valuation ? ` at ${money(x.valuation)}` : ''}`;
      const amt = x.kind !== 'valuation' && x.amount ? `<b>${money(x.amount, x.fx)}</b> ` : '';
      return `<li><time>${fullDay(x.at)}</time><div><p>${amt}${what}${x.talks ? ' <span class="dl-kind talk">In talks</span>' : ''}</p>
        <ul>${x.docs.slice(0, 3).map((doc) => `<li><a href="${esc(doc.url)}" target="_blank" rel="noopener">${esc(doc.title)}</a> <small>${esc(doc.site)}</small></li>`).join('')}</ul></div></li>`;
    }).join('');
    const links = `<a class="tr-link" href="#trends?q=${encodeURIComponent(c.company)}">${esc(c.company)} in Trends →</a> <a class="tr-link" href="#search?q=${encodeURIComponent(`"${c.company}"`)}">All coverage →</a>`;
    return `<section class="topic-card dl-panel" aria-live="polite">
      <div class="head-row"><h2>${esc(c.company)}</h2>${close}</div>
      <p class="dl-facts">${c.raised ? `<span><b>${money(c.raised)}</b> raised on record</span>` : ''}<span><b>${c.deals.length}</b> ${c.deals.length === 1 ? 'deal' : 'deals'}</span>${links}</p>
      ${chartHtml}
      <h3 class="dl-sub">Every deal on record</h3><ol class="dl-timeline">${timeline}</ol>
    </section>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `Deals · ${name}`;
    const ranges = RANGES.map(([k, l]) => `<a href="${href({ range: k })}" aria-pressed="${view.range === k}">${l}</a>`).join('');
    const kinds = KINDS.map(([k, l]) => `<a href="${href({ kind: k })}" aria-pressed="${view.kind === k}">${l}</a>`).join('');
    const head = `<header class="topic-head">
        <p class="kicker">Money</p>
        <h1>Deals</h1>
        <p class="topic-sum">Funding rounds, valuations and acquisitions in AI, read from headlines and grouped across every outlet that reported them. Amounts in US dollars; ≈ marks a conversion.</p>
      </header>
      <div class="md-bar"><nav class="seg seg-mode" aria-label="Kind">${kinds}</nav><nav class="seg seg-mode" aria-label="Period">${ranges}</nav></div>`;
    if (state.mode !== 'api') {
      setHtml($('#dealsView'), `${head}<p class="rail-note">Deals need the live server.</p>`);
      return;
    }
    load();
    const hit = cache.get(view.range);
    if (!hit?.d) {
      chartMeta = null;
      setHtml($('#dealsView'), `${head}${companyPanel()}${hit?.error ? `<p class="rail-note">Deals are unavailable: ${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const d = hit.d;
    const animate = drawn !== d && !reducedMotion();
    drawn = d;
    const focused = document.activeElement?.id === 'dlFind';
    // The chart and the raisers are about rounds; acquisitions get the list alone.
    const rounds = view.kind !== 'acquisition';
    if (!rounds) chartMeta = null;
    setHtml($('#dealsView'), `${head}${companyPanel()}${tiles(d)}${rounds ? chart(d, animate) : ''}<div class="dl-grid${rounds ? '' : ' solo'}">${list(d)}${rounds ? top(d) : ''}</div><div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
    if (focused) $('#dlFind')?.focus();
  }

  function onClick(t) {
    const ds = t.dataset;
    if (ds.dlco) {
      location.hash = href({ co: ds.dlco });
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }));
      return true;
    }
    if (ds.dlsort) { view.sort = ds.dlsort; view.shown = PAGE; render(); return true; }
    if (ds.dlmore != null) { view.shown += PAGE; render(); return true; }
    return false;
  }

  function onInput(e) {
    if (e.target.id !== 'dlFind') return false;
    view.find = e.target.value;
    view.shown = PAGE;
    render();
    return true;
  }

  function hover(e) {
    const co = $('#dealsView svg[data-chart="dealsco"]');
    if (co && coMeta) {
      const on = e.type !== 'pointerleave' && e.target.closest?.('svg[data-chart="dealsco"]');
      const i = on ? pointAt(co, coMeta.meta, e.clientX) : -1;
      const v = coMeta.vals[i];
      showPoint(co, coMeta.meta, i, $('#dealsView .tr-tip'), $('#dealsView'), v ? `<p class="tt-h">${fullDay(v.at)}</p><p>Valued at <b>${money(v.valuation)}</b>${v.round ? ` <small>${esc(v.round)}</small>` : ''}</p>` : '', setHtml);
      if (on) return;
    }
    const svg = $('#dealsView svg.lc.bc');
    const tip = $('#dealsView .tr-tip');
    if (!svg || !chartMeta) return;
    const i = e.type === 'pointerleave' || !e.target.closest?.('svg.lc.bc') ? -1 : pointAt(svg, chartMeta.meta, e.clientX);
    const { d } = chartMeta;
    const t = d.buckets[i];
    const total = i < 0 ? 0 : STAGES.reduce((a, [k]) => a + d.raised[k][i], 0);
    const html = i < 0 ? '' : `<p class="tt-h">${d.unit === 'month' ? new Date(t).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `Week of ${fullDay(t)}`} · <b>${money(total)}</b> <small>${d.counts[i]} ${d.counts[i] === 1 ? 'round' : 'rounds'}</small></p>${STAGES.filter(([k]) => d.raised[k][i]).map(([k, label, c]) => `<p><i class="sw" style="--c:${c}"></i>${label} <b>${money(d.raised[k][i])}</b></p>`).join('')}`;
    showPoint(svg, chartMeta.meta, i, tip, $('#dealsView'), html, setHtml);
  }

  return { route, render, onClick, onInput, hover };
}
