// Head to head (#vs): two labs, people or products side by side — how the
// coverage splits, day by day, which outlets lean to which, the words that
// set each one's headlines apart, who comes up with each, their biggest
// days and their money. Server side: src/index/versus.js.

import { lineChart, pointAt, showPoint } from './charts.js';

const DAY = 86400e3;
const WINDOWS = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const PAIRS = [['openai', 'anthropic'], ['google', 'openai'], ['nvidia', 'amd'], ['chatgpt', 'claude'], ['sam-altman', 'elon-musk'], ['deepseek', 'openai'], ['meta', 'google'], ['microsoft', 'amazon']];
const pct = (v) => `${Math.round(v * 100)}%`;
const money = (v) => (v >= 1e12 ? `$${+(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${v}`);
const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;

export function createVersus({ $, esc, setHtml, state, reducedMotion }) {
  const view = { a: 'openai', b: 'anthropic', days: 30 };
  const cache = new Map(); // key -> { d, error, pending, at }
  let names = [];
  let chart = null;
  let drawn = null;

  const keyOf = () => `${view.days}:${view.a}:${view.b}`;
  const hrefOf = (a, b, days = view.days) => `#vs?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${days !== 30 ? `&days=${days}` : ''}`;

  function route(hash) {
    const m = /^#vs(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    const clean = (s, d) => (s || d).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60) || d;
    view.a = clean(p.get('a'), 'openai');
    view.b = clean(p.get('b'), 'anthropic');
    const days = Number(p.get('days'));
    view.days = WINDOWS.some(([d]) => d === days) ? days : 30;
    return 'versus';
  }

  async function load(key) {
    const hit = cache.get(key);
    if (hit?.pending || (hit?.d && Date.now() - hit.at < 10 * 60e3) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    cache.set(key, { ...hit, pending: true });
    const [days, a, b] = key.split(':');
    try {
      const r = await fetch(`/api/versus?a=${a}&b=${b}&days=${days}`);
      const d = await r.json();
      if (d.names?.length) names = d.names;
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(key, { d, at: Date.now() });
    } catch (err) {
      cache.set(key, { d: hit?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'versus' && keyOf() === key) render();
  }

  function picker(side, current, other) {
    const opts = names.length ? names : [{ key: current, label: current }];
    const groups = [['org', 'Companies and labs'], ['person', 'People'], ['product', 'Products'], ['gov', 'Governments'], ['other', 'Also in the news']];
    const has = opts.some((n) => n.key === current);
    return `<label class="vs-pick vs-${side}"><span class="visually-hidden">${side === 'a' ? 'First' : 'Second'} name</span><select data-side="${side}">
      ${has ? '' : `<option value="${esc(current)}" selected>${esc(current)}</option>`}
      ${groups.map(([t, l]) => {
        const g = opts.filter((n) => (n.type || 'other') === t && n.key !== other);
        return g.length ? `<optgroup label="${l}">${g.map((n) => `<option value="${esc(n.key)}"${n.key === current ? ' selected' : ''}>${esc(n.label)}</option>`).join('')}</optgroup>` : '';
      }).join('')}
    </select></label>`;
  }

  function change(x) {
    if (x.prev == null || !x.prev) return '';
    const c = (x.n - x.prev) / x.prev;
    if (Math.abs(c) < 0.05) return '<small class="vs-ch">about the same as before</small>';
    return `<small class="vs-ch ${c > 0 ? 'up' : 'down'}">${c > 0 ? '↑' : '↓'} ${pct(Math.abs(c))} on the ${view.days} days before</small>`;
  }

  // The tug of war: one bar split by share of the coverage naming either.
  function hero(d) {
    const total = d.a.n + d.b.n;
    const sa = total ? d.a.n / total : 0.5;
    return `<section class="vs-hero" aria-label="Share of coverage">
      <div class="vs-side vs-a"><p class="vs-name"><a href="#graph/${esc(d.a.key)}">${esc(d.a.label)}</a></p><p class="vs-n"><b>${d.a.n.toLocaleString()}</b> articles</p>${change(d.a)}</div>
      <div class="vs-side vs-b"><p class="vs-name"><a href="#graph/${esc(d.b.key)}">${esc(d.b.label)}</a></p><p class="vs-n"><b>${d.b.n.toLocaleString()}</b> articles</p>${change(d.b)}</div>
      <div class="vs-bar" role="img" aria-label="${esc(`${d.a.label} ${pct(sa)}, ${d.b.label} ${pct(1 - sa)}`)}"><i class="vs-ba" style="--w:${(sa * 100).toFixed(1)}%"><span>${pct(sa)}</span></i><i class="vs-bb" style="--w:${((1 - sa) * 100).toFixed(1)}%"><span>${pct(1 - sa)}</span></i></div>
      <p class="vs-both"><b>${d.both.n.toLocaleString()}</b> articles named both${total ? ` · ${pct(d.both.n / Math.max(1, Math.min(d.a.n, d.b.n)))} of ${esc(d.a.n <= d.b.n ? d.a.label : d.b.label)}’s coverage` : ''}</p>
    </section>`;
  }

  function daily(d, animate) {
    const narrow = innerWidth < 640;
    const xs = d.series.a.map((_, i) => d.since + i * DAY);
    const series = [
      { key: 'a', label: d.a.label, color: 'var(--s1c)', values: d.series.a },
      { key: 'b', label: d.b.label, color: 'var(--s2c)', values: d.series.b },
    ];
    const every = Math.ceil(xs.length / (narrow ? 4 : 7));
    const { svg, meta } = lineChart({ id: 'vsday', xs, series, W: narrow ? 380 : 760, H: narrow ? 190 : 240, animate, endLabels: !narrow, xTicks: xs.map((_, i) => i).filter((i) => i % every === 0), xFmt: dayFmt, label: `Articles per day naming ${d.a.label} and ${d.b.label}` });
    chart = { meta, tip: (i) => `<p class="tt-h">${dayFmt(xs[i])}</p><p><i class="sw" style="--c:var(--s1c)"></i><b>${d.series.a[i]}</b> ${esc(d.a.label)}</p><p><i class="sw" style="--c:var(--s2c)"></i><b>${d.series.b[i]}</b> ${esc(d.b.label)}</p>${d.series.both[i] ? `<p>${d.series.both[i]} named both</p>` : ''}` };
    return `<section class="topic-card"><h2>Day by day<small>articles naming each</small></h2>
      <ul class="tr-legend"><li style="--c:var(--s1c)"><i class="sw"></i>${esc(d.a.label)}</li><li style="--c:var(--s2c)"><i class="sw"></i>${esc(d.b.label)}</li></ul>
      <div class="tr-plot">${svg}</div></section>`;
  }

  // Outlets: a diverging bar from the overall split, toward whichever side
  // the outlet covered more than everyone else did.
  function outlets(d) {
    if (!d.outlets.length) return '';
    const max = Math.max(0.05, ...d.outlets.map((o) => Math.abs(o.lean)));
    return `<section class="vs-outlets"><h2 class="when">Who leans which way<span>each outlet’s split against the overall ${pct(d.a.n / Math.max(1, d.a.n + d.b.n))} / ${pct(d.b.n / Math.max(1, d.a.n + d.b.n))}</span></h2>
      <div class="vs-axis" aria-hidden="true"><span></span><span class="vs-at"><span>← more ${esc(d.a.label)}</span><span>more ${esc(d.b.label)} →</span></span><span></span></div>
      <ul class="vs-lean">${d.outlets.map((o, i) => {
        const w = (Math.abs(o.lean) / max) * 50;
        const toA = o.lean > 0;
        return `<li style="--i:${i}" title="${esc(`${o.name}: ${o.a} ${d.a.label}, ${o.b} ${d.b.label}`)}"><span class="vs-on">${esc(o.name)}</span><span class="vs-track"><i class="${toA ? 'to-a' : 'to-b'}" style="--w:${w.toFixed(1)}%"></i></span><span class="vs-oc"><b class="ca">${o.a}</b> · <b class="cb">${o.b}</b></span></li>`;
      }).join('')}</ul></section>`;
  }

  function words(x, cls) {
    if (!x.words.length) return '<p class="rail-note">Nothing stands out.</p>';
    const max = Math.max(...x.words.map((w) => w.z));
    return `<ul class="vs-words ${cls}">${x.words.map((w, i) => `<li style="--i:${i};--s:${(0.85 + (w.z / max) * 0.5).toFixed(2)}"><a href="#search?q=${encodeURIComponent(`${x.label} ${w.word}`)}">${esc(w.word)}</a><small>${w.n}</small></li>`).join('')}</ul>`;
  }

  function withList(x) {
    if (!x.with.length) return '';
    const max = Math.max(...x.with.map((w) => w.share));
    return `<ol class="dy-names vs-with">${x.with.map((w, i) => `<li style="--i:${i}"><a href="${esc(hrefOf(x.key, w.key))}" title="Compare ${esc(x.label)} with ${esc(w.label)}">${esc(w.label)}</a><b>${pct(w.share)}</b><span class="dy-bar"><i style="width:${Math.max(4, (w.share / max) * 100).toFixed(1)}%"></i></span></li>`).join('')}</ol>`;
  }

  function moneyBlock(x) {
    const m = x.deals;
    if (!m || (!m.raised && !m.valuation && !m.recent.length)) return '';
    return `<div class="vs-money">${m.raised ? `<p><b>${money(m.raised)}</b><small>raised (all time, reported)</small></p>` : ''}${m.valuation ? `<p><b>${money(m.valuation)}</b><small>last valuation · ${esc(dayFmt(m.valuedAt))}</small></p>` : ''}</div>
      ${m.recent.filter((r) => r.title).length ? `<ul class="dy-list">${m.recent.filter((r) => r.title).map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><small>${esc(dayFmt(r.at))}${r.amount ? ` · ${money(r.amount)}` : ''}${r.talks ? ' · in talks' : ''}</small></li>`).join('')}</ul>` : ''}`;
  }

  function headlines(list) {
    return `<ul class="vs-heads">${list.map((h, i) => `<li style="--i:${i}"><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><small><img src="${esc(fav(hostOf(h.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(h.source)} · ${esc(dayFmt(h.at))}</small></li>`).join('')}</ul>`;
  }

  function column(x, cls) {
    return `<div class="vs-col ${cls}">
      <h3 class="vs-ch3"><i class="sw" style="--c:var(--${cls === 'ca' ? 's1c' : 's2c'})"></i>${esc(x.label)}</h3>
      <section><h2 class="when">Words that set it apart</h2>${words(x, cls)}</section>
      ${x.peak ? `<section><h2 class="when">Biggest day<span>${esc(dayFmt(x.peak.at))} · ${x.peak.n} articles</span></h2><p class="vs-peak"><a href="${esc(x.peak.url)}" target="_blank" rel="noopener">${esc(x.peak.title)}</a><small>${esc(x.peak.source)}</small></p></section>` : ''}
      ${x.with.length ? `<section><h2 class="when">Seen with<span>share of its articles</span></h2>${withList(x)}</section>` : ''}
      ${moneyBlock(x) ? `<section><h2 class="when">Money</h2>${moneyBlock(x)}</section>` : ''}
      <section><h2 class="when">Only about ${esc(x.label)}</h2>${headlines(x.headlines)}</section>
    </div>`;
  }

  function page(d, animate) {
    return `${hero(d)}
      ${daily(d, animate)}
      <div class="vs-cols">${column(d.a, 'ca')}${column(d.b, 'cb')}</div>
      ${d.both.headlines.length ? `<section class="vs-together"><h2 class="when">Together<span>${d.both.n} articles named both</span></h2>${headlines(d.both.headlines)}</section>` : ''}
      ${outlets(d)}
      <p class="rail-note">From ${d.articles.toLocaleString()} English articles over ${d.days} days; an article counts for a name when its headline or summary uses it. Words are ranked by weighted log-odds against everything else in the window.</p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#versusView');
    const key = keyOf();
    if (state.mode === 'api') load(key);
    const hit = cache.get(key) || {};
    const d = hit.d;
    const la = d?.a?.label || names.find((n) => n.key === view.a)?.label || view.a;
    const lb = d?.b?.label || names.find((n) => n.key === view.b)?.label || view.b;
    document.title = `${la} vs ${lb} · ${site}`;
    const head = `<header class="topic-head vs-head">
        <p class="kicker">Head to head</p>
        <div class="vs-pickers">${picker('a', view.a, view.b)}<a class="vs-swap" href="${esc(hrefOf(view.b, view.a))}" aria-label="Swap sides" title="Swap sides">⇄</a>${picker('b', view.b, view.a)}</div>
        <nav class="pd-chips" aria-label="Window">${WINDOWS.map(([n, l]) => `<a class="chip${view.days === n ? ' on' : ''}" href="${esc(hrefOf(view.a, view.b, n))}">${l}</a>`).join('')}</nav>
        <nav class="vs-pairs" aria-label="Popular match-ups">${PAIRS.filter(([a, b]) => !(a === view.a && b === view.b)).slice(0, 6).map(([a, b]) => {
          const l = (k) => names.find((n) => n.key === k)?.label || k;
          return `<a href="${esc(hrefOf(a, b))}">${esc(l(a))} <i>vs</i> ${esc(l(b))}</a>`;
        }).join('')}</nav>
      </header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Head to head needs the live server.</p>`);
      return;
    }
    if (!d) {
      chart = null;
      setHtml(host, `${head}${hit.error ? `<p class="rail-note">${esc(hit.error)}</p>` : '<i class="skeleton" style="height:120px;display:block;margin:16px 0;border-radius:12px"></i><i class="skeleton" style="height:220px;display:block;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== d && !reducedMotion();
    drawn = d;
    setHtml(host, `${head}<div class="vs-page${animate ? ' animate' : ''}">${page(d, animate)}</div><div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
  }

  function hover(e) {
    const svg = $('#versusView svg[data-chart="vsday"]');
    if (!svg || !chart) return;
    const on = e.type !== 'pointerleave' && e.target.closest?.('svg[data-chart="vsday"]');
    const i = on ? pointAt(svg, chart.meta, e.clientX) : -1;
    showPoint(svg, chart.meta, i, $('#versusView .tr-tip'), $('#versusView'), i < 0 ? '' : chart.tip(i), setHtml);
  }

  function onChange(e) {
    const sel = e.target.closest('select[data-side]');
    if (!sel) return;
    const a = sel.dataset.side === 'a' ? sel.value : view.a;
    const b = sel.dataset.side === 'b' ? sel.value : view.b;
    location.hash = hrefOf(a, b);
  }

  return { route, render, hover, onChange };
}
