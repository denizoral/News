// Predictions (#predictions): what people and companies say will happen, and
// by when — a chart of the years forecasts come due, what's coming due now
// with how much of its time has run, and the ledger by year, filterable by
// theme, year and forecaster.
// Server side: src/index/forecasts.js.

import { barChart, pointAt, showPoint } from './charts.js';

const DAY = 86400e3;
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const date = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// Forecasts come due at the end of their year.
const dueAt = (year) => Date.UTC(year, 11, 31, 23, 59);
const LATER = 14; // years shown one by one; beyond that, one bar

export function createPredictions({ $, esc, setHtml, state, reducedMotion }) {
  const view = { theme: '', year: 0, who: '' };
  const cache = new Map(); // query -> { d, error, pending, at }
  let chart = null;
  let drawn = null;
  let lastKey = '';

  const keyOf = (v = view) => `${v.theme}|${v.year}|${v.who}`;
  const hashOf = (v) => {
    const p = new URLSearchParams();
    if (v.theme) p.set('theme', v.theme);
    if (v.year) p.set('year', v.year);
    if (v.who) p.set('who', v.who);
    const s = p.toString();
    return `#predictions${s ? `?${s}` : ''}`;
  };

  function route(hash) {
    const m = /^#predictions(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.theme = (p.get('theme') || '').replace(/[^a-z]/g, '').slice(0, 20);
    view.year = Number(p.get('year')) || 0;
    view.who = (p.get('who') || '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
    return 'predictions';
  }

  async function load(v) {
    const k = keyOf(v);
    const hit = cache.get(k);
    if (hit?.pending || (hit?.d && Date.now() - hit.at < 10 * 60e3) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    cache.set(k, { ...hit, pending: true });
    const q = hashOf(v).replace('#predictions', '');
    try {
      const r = await fetch(`/api/predictions${q}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(k, { d, at: Date.now() });
    } catch (err) {
      cache.set(k, { d: hit?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'predictions' && keyOf() === k) render();
  }

  // The sentence, with the words that set its date marked.
  function sentence(f) {
    const i = f.phrase ? f.text.indexOf(f.phrase) : -1;
    if (i < 0) return esc(f.text);
    return `${esc(f.text.slice(0, i))}<mark>${esc(f.phrase)}</mark>${esc(f.text.slice(i + f.phrase.length))}`;
  }

  const whoLink = (f) => (f.person
    ? `<a href="#person/${esc(f.key)}">${esc(f.name)}</a>`
    : `<a href="${esc(hashOf({ ...view, who: f.key, year: 0 }))}">${esc(f.name)}</a>`);

  function card(f, i, themes) {
    const theme = themes.get(f.theme);
    const copies = f.copies.length > 1
      ? `<details class="qt-copies"><summary>Carried by ${plural(f.outlets, 'outlet')}</summary><ul>${f.copies.map((c) => `<li><img src="${esc(fav(hostOf(c.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source)}</a><small>${date(c.at)}</small></li>`).join('')}</ul></details>`
      : '';
    return `<li class="pd-card" style="--i:${Math.min(i, 12)}">
      <p class="pd-who">${whoLink(f)}${f.role ? `<span>, ${esc(f.role)}</span>` : ''}${f.kind === 'plan' ? '<em class="pd-kind">Plan</em>' : ''}${theme && f.theme !== 'other' ? `<em>${esc(theme)}</em>` : ''}</p>
      <p class="pd-text">${f.quoted ? '“' : ''}${sentence(f)}${f.quoted ? '”' : ''}</p>
      <p class="qt-src"><img src="${esc(fav(hostOf(f.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.title)}">${esc(f.source)}</a> · said ${date(f.at)}</p>
      ${copies}
    </li>`;
  }

  // Coming due: how much of the time between saying it and its deadline has gone.
  function dueCard(f, i, now) {
    const end = dueAt(f.year);
    const frac = Math.max(0.02, Math.min(1, (now - f.at) / Math.max(DAY, end - f.at)));
    const left = Math.max(0, Math.ceil((end - now) / DAY));
    const leftTxt = left > 400 ? `${Math.round(left / 365 * 10) / 10} years left` : plural(left, 'day') + ' left';
    return `<li class="pd-due" style="--i:${i}">
      <p class="pd-who">${whoLink(f)}<em>Due ${f.year}</em></p>
      <p class="pd-text">${sentence(f)}</p>
      <div class="pd-meter" role="img" aria-label="${Math.round(frac * 100)}% of the time to its deadline has passed; ${leftTxt}"><i style="--w:${(frac * 100).toFixed(1)}%"></i></div>
      <p class="pd-left"><span>Said ${date(f.at)}</span><b>${leftTxt}</b></p>
    </li>`;
  }

  function yearChart(d, animate) {
    const ys = d.years;
    if (!ys.length) return '';
    const first = ys[0].year;
    const shown = ys.filter((y) => y.year < first + LATER);
    const later = ys.filter((y) => y.year >= first + LATER).reduce((n, y) => n + y.n, 0);
    const bars = later ? [...shown, { year: 'later', n: later }] : shown;
    const sel = bars.findIndex((b) => b.year === view.year);
    const narrow = innerWidth < 640;
    const every = Math.ceil(bars.length / (narrow ? 5 : 9));
    const xTicks = bars.map((_, i) => i).filter((i) => i % every === 0 || i === bars.length - 1);
    const label = (b) => (b.year === 'later' ? `${first + LATER}+` : String(b.year));
    // One series; with a year chosen, the others step back.
    const stacks = sel < 0
      ? [{ key: 'n', label: 'Forecasts', color: 'var(--s1c)', values: bars.map((b) => b.n) }]
      : [{ key: 'rest', label: 'Forecasts', color: 'var(--pd-dim)', values: bars.map((b, i) => (i === sel ? 0 : b.n)) },
        { key: 'sel', label: 'Forecasts', color: 'var(--s1c)', values: bars.map((b, i) => (i === sel ? b.n : 0)) }];
    const { svg, meta } = barChart({ id: 'pdyears', xs: bars.map((b) => b.year), stacks, W: narrow ? 380 : 760, H: narrow ? 160 : 190, animate, xTicks, xFmt: (_, i) => label(bars[i]), label: 'Forecasts by the year they come due' });
    chart = { meta, bars, tip: (i) => `<p class="tt-h">${label(bars[i])}</p><p><b>${bars[i].n}</b> ${bars[i].n === 1 ? 'forecast' : 'forecasts'} due</p>${bars[i].year !== 'later' && bars[i].n ? '<p class="tt-s">Click to see them</p>' : ''}` };
    return `<section class="topic-card pd-chart"><h2>When they say it happens<small>forecasts by the year they come due</small></h2><div class="tr-plot">${svg}</div></section>`;
  }

  function page(d, animate) {
    const themes = new Map(d.themes.map((t) => [t.key, t.label]));
    const total = d.themes.reduce((n, t) => n + t.n, 0);
    const chips = `<nav class="pd-chips" aria-label="Themes">
      <a class="chip${!view.theme ? ' on' : ''}" href="${esc(hashOf({ ...view, theme: '', year: 0 }))}">All<small>${total}</small></a>
      ${d.themes.filter((t) => t.n).map((t) => `<a class="chip${view.theme === t.key ? ' on' : ''}" href="${esc(hashOf({ ...view, theme: t.key, year: 0 }))}">${esc(t.label)}<small>${t.n}</small></a>`).join('')}
    </nav>`;
    const whoName = d.who && (d.forecasts[0]?.name || d.who);
    const filters = [
      d.who ? `<a class="chip on" href="${esc(hashOf({ ...view, who: '' }))}" aria-label="Clear forecaster">${esc(whoName)} <span aria-hidden="true">×</span></a>` : '',
      d.year ? `<a class="chip on" href="${esc(hashOf({ ...view, year: 0 }))}" aria-label="Clear year">Due ${d.year} <span aria-hidden="true">×</span></a>` : '',
    ].join('');
    const due = d.due.length && !d.who
      ? `<section class="pd-dues"><h2 class="when">Coming due<span>this year and next</span></h2><ol class="pd-due-list${animate ? ' animate' : ''}">${d.due.map((f, i) => dueCard(f, i, d.generatedAt)).join('')}</ol></section>`
      : '';
    // The ledger, by the year each comes due.
    const byYear = new Map();
    for (const f of d.forecasts) {
      if (!byYear.has(f.year)) byYear.set(f.year, []);
      byYear.get(f.year).push(f);
    }
    let n = 0;
    const ledger = [...byYear].sort((a, b) => a[0] - b[0]).map(([y, fs]) => `<section class="pd-year">
        <h2 class="when"><a href="${esc(hashOf({ ...view, year: y }))}">${y}</a><span>${plural(fs.length, 'forecast')}${y === d.thisYear ? ' · this year' : ''}</span></h2>
        <ol class="pd-list${animate ? ' animate' : ''}">${fs.map((f) => card(f, n++, themes)).join('')}</ol>
      </section>`).join('');
    const who = d.who_.length && !d.who
      ? `<section class="dy-side"><h2 class="when">Who makes the most calls</h2><ul class="qt-where pd-whos">${d.who_.map((w) => `<li><a href="${esc(w.person ? `#person/${w.key}` : hashOf({ ...view, who: w.key, year: 0 }))}">${esc(w.name)}</a><i style="width:${((w.n / d.who_[0].n) * 100).toFixed(1)}%"></i><small>${w.n}</small></li>`).join('')}</ul>
        <p class="rail-note">People link to everything they’re quoted saying; firms filter this page.</p></section>`
      : '';
    const how = `<section class="dy-side"><h2 class="when">How this works</h2><p class="rail-note">Sentences in ${d.days} days of AI coverage that put a claim about the future on a year — “by 2030”, “within five years” — and name who made it: a quoted speaker, the subject of “expects” or “predicts”, or “according to”. <b>Plans</b> are what a company says it will do itself. The same forecast in several outlets is listed once.</p></section>`;
    return `<ul class="ss-tiles">
        <li style="--i:0"><b>${d.totals.forecasts.toLocaleString()}</b><span>forecasts ${d.who ? `by ${esc(whoName)}` : `in ${d.days} days of coverage`}</span></li>
        <li style="--i:1"><b>${d.totals.who.toLocaleString()}</b><span>people and firms making them</span></li>
        <li style="--i:2"><b>${(d.years.find((y) => y.year === d.thisYear)?.n || 0) + (d.years.find((y) => y.year === d.thisYear + 1)?.n || 0)}</b><span>due by the end of ${d.thisYear + 1}</span></li>
      </ul>
      ${chips}
      ${yearChart(d, animate)}
      ${filters ? `<p class="pd-filters">${filters}</p>` : ''}
      <div class="dy-grid">
        <div>${due}${ledger || '<p class="rail-note">No forecast matches.</p>'}</div>
        <aside>${who}${how}</aside>
      </div>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    const host = $('#predictionsView');
    document.title = `Predictions · ${name}`;
    const head = `<header class="topic-head">
        <p class="kicker">Ahead</p>
        <h1>Predictions</h1>
        <p class="topic-sum">What people and companies say will happen in AI, and by when — pulled from the coverage, pinned on who said it, and sorted by the year it comes due.</p>
      </header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Predictions need the live server.</p>`);
      return;
    }
    const k = keyOf();
    load({ ...view });
    const hit = cache.get(k) || {};
    if (hit.d) lastKey = k;
    // While a filter loads, the last page stays up.
    const shown = hit.d || cache.get(lastKey)?.d;
    if (!shown) {
      setHtml(host, `${head}${hit.error ? `<p class="rail-note">Predictions are unavailable: ${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const animate = !drawn && !reducedMotion();
    drawn = shown;
    setHtml(host, `${head}${page(shown, animate)}<div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
  }

  function hover(e) {
    const svg = $('#predictionsView svg[data-chart="pdyears"]');
    if (!svg || !chart) return;
    const on = e.type !== 'pointerleave' && e.target.closest?.('svg[data-chart="pdyears"]');
    const i = on ? pointAt(svg, chart.meta, e.clientX) : -1;
    svg.style.cursor = i >= 0 && chart.bars[i].year !== 'later' && chart.bars[i].n ? 'pointer' : '';
    showPoint(svg, chart.meta, i, $('#predictionsView .tr-tip'), $('#predictionsView'), i < 0 ? '' : chart.tip(i), setHtml);
  }

  // A bar opens its year; the chosen one again clears it.
  function onClick(e) {
    const svg = e.target.closest?.('svg[data-chart="pdyears"]');
    if (!svg || !chart) return false;
    const i = pointAt(svg, chart.meta, e.clientX);
    const b = chart.bars[i];
    if (!b || b.year === 'later' || !b.n) return false;
    location.hash = hashOf({ ...view, year: view.year === b.year ? 0 : b.year });
    return true;
  }

  return { route, render, hover, onClick };
}
