// Who said what (#quotes, #person/<key>): the lines carried by the most
// outlets this week, everyone being quoted about AI, and a page per person
// with every line they were quoted saying.
// Server side: src/index/quotes.js.

import { barChart, pointAt, showPoint } from './charts.js';

const DAY = 86400e3;
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const date = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ago = (t) => {
  const d = Math.floor((Date.now() - t) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : date(t);
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const initials = (name) => name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// A 30-day sparkline: 2px line, last point marked.
function spark(days) {
  const W = 88, H = 24, max = Math.max(1, ...days);
  const pts = days.map((v, i) => [(i / (days.length - 1)) * (W - 4) + 2, H - 3 - (v / max) * (H - 6)]);
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="ol-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5"/></svg>`;
}

export function createQuotes({ $, esc, setHtml, state, reducedMotion }) {
  const view = { key: null, find: '' };
  const lists = new Map(); // filter -> { d, error, pending, at }
  const people = new Map(); // key -> { d, error, pending, at }
  let charts = {};
  let drawn = null;
  let typing = null;
  let lastQ = '';

  function route(hash) {
    if (hash === '#quotes') {
      view.key = null;
      return 'quotes';
    }
    const m = /^#person\/([a-z0-9-]{2,60})$/.exec(hash);
    if (!m) return null;
    view.key = m[1];
    return 'quotes';
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }

  async function loadList(q) {
    const hit = lists.get(q);
    if (hit?.pending || (hit?.d && Date.now() - hit.at < 10 * 60e3) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    lists.set(q, { ...hit, pending: true });
    try {
      lists.set(q, { d: await fetchJson(`/api/quotes${q ? `?q=${encodeURIComponent(q)}` : ''}`), at: Date.now() });
    } catch (err) {
      lists.set(q, { d: hit?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'quotes' && !view.key && view.find.trim().toLowerCase() === q) render();
  }

  async function loadPerson(key) {
    const hit = people.get(key);
    if (hit?.pending || hit?.d || (hit?.error && Date.now() - hit.at < 20e3)) return;
    people.set(key, { pending: true });
    try {
      people.set(key, { d: await fetchJson(`/api/person?name=${key}`), at: Date.now() });
    } catch (err) {
      people.set(key, { error: err.message, at: Date.now() });
    }
    if (state.view === 'quotes' && view.key === key) render();
  }

  // A pull quote: the line, who said it, and every outlet that ran it.
  function pull(l, i, { person = true } = {}) {
    const more = l.copies.length > 1
      ? `<details class="qt-copies"><summary>Ran in ${plural(l.outlets, 'outlet')}</summary><ul>${l.copies.map((c) => `<li><img src="${esc(fav(c.site))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source)}</a><small>${date(c.at)}</small></li>`).join('')}</ul></details>`
      : '';
    return `<li class="qt-card" style="--i:${Math.min(i, 12)}">
      <blockquote><p>${esc(l.text)}</p></blockquote>
      <p class="qt-by">${person ? `<a href="#person/${esc(l.key)}">${esc(l.name)}</a>${l.role ? `<span>, ${esc(l.role)}</span>` : ''}` : ''}</p>
      <p class="qt-src"><img src="${esc(fav(hostOf(l.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.title)}">${esc(l.source)}</a> · ${ago(l.at)}</p>
      ${more}
    </li>`;
  }

  function directory(d, animate) {
    const lines = d.lines.length
      ? `<ol class="qt-wall${animate ? ' animate' : ''}">${d.lines.map((l, i) => pull(l, i)).join('')}</ol>`
      : `<p class="rail-note">${d.q ? `No line this week mentions “${esc(d.q)}”.` : 'No line was carried by two outlets this week.'}</p>`;
    const rows = d.people.map((p, i) => `<li style="--i:${Math.min(i, 20)}"><a class="qt-row" href="#person/${esc(p.key)}">
        <span class="qt-mono" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="qt-name"><b>${esc(p.name)}</b><small>${esc(p.role || '')}</small></span>
        ${spark(p.spark)}
        <span class="ol-num"><b>${p.articles}</b><small>${p.articles === 1 ? 'article' : 'articles'}</small></span>
        <span class="ol-num"><b>${p.outlets}</b><small>outlets</small></span>
        <span class="ol-beat">${p.about.map((a) => `<em>${esc(a.label)}</em>`).join('')}</span>
      </a></li>`).join('');
    return `<ul class="ss-tiles">
        <li style="--i:0"><b>${d.totals.quotes.toLocaleString()}</b><span>quotes in AI coverage, last ${d.days} days</span></li>
        <li style="--i:1"><b>${d.totals.people.toLocaleString()}</b><span>people quoted by two or more outlets</span></li>
      </ul>
      <section class="qt-lines"><h2 class="when">Most-carried lines this week</h2>${lines}</section>
      <section class="ol-dir qt-people">
        <div class="dl-tools"><h2 class="when">Who’s being quoted<span>${d.people.length}</span></h2>
          <label class="visually-hidden" for="qtFind">Filter people and quotes</label>
          <input id="qtFind" type="search" placeholder="Name or subject, e.g. Nvidia" autocomplete="off" value="${esc(view.find)}"></div>
        <p class="qt-cols" aria-hidden="true"><span></span><span>Person</span><span>${d.days} days</span><span>Quoted in</span><span>By</span><span>Talks about</span></p>
        ${rows ? `<ol class="ol-list">${rows}</ol>` : `<p class="rail-note">Nobody quoted matches “${esc(d.q)}”.</p>`}
      </section>`;
  }

  function dailyChart(p, animate) {
    const narrow = innerWidth < 640;
    const xs = p.daily.map((_, i) => p.generatedAt - (p.daily.length - 1 - i) * DAY);
    const { svg, meta } = barChart({ id: 'qtdaily', xs, stacks: [{ key: 'n', label: 'Quotes', color: 'var(--s1c)', values: p.daily }], W: narrow ? 380 : 760, H: narrow ? 150 : 170, animate, xFmt: (t) => date(t), label: `${p.name}: quotes per day, last ${p.days} days` });
    charts.qtdaily = { meta, tip: (i) => `<p class="tt-h">${date(xs[i])}</p><p><b>${p.daily[i]}</b> ${p.daily[i] === 1 ? 'quote' : 'quotes'}</p>` };
    return svg;
  }

  function personPage(p, animate) {
    charts = {};
    const t = p.totals;
    const tiles = [
      [t.lines, `different lines in ${p.days} days`],
      [t.articles, 'articles quoting them'],
      [t.outlets, 'outlets'],
      [ago(t.last), 'last quoted'],
    ];
    const omax = Math.max(1, ...p.outlets.map((o) => o.n));
    const where = `<section class="dy-side"><h2 class="when">Quoted by</h2><ul class="qt-where">${p.outlets.map((o) => `<li><span>${esc(o.name)}</span><i style="width:${((o.n / omax) * 100).toFixed(1)}%"></i><small>${o.n}</small></li>`).join('')}</ul></section>`;
    const along = p.alongside.length ? `<section class="dy-side"><h2 class="when">In the same stories</h2><ul class="ol-authors">${p.alongside.map((a) => `<li><a href="#person/${esc(a.key)}">${esc(a.name)}</a><small>${a.n}</small></li>`).join('')}</ul></section>` : '';
    const about = p.about.length ? `<div class="ol-btns">${p.about.map((a) => `<a class="chip" href="#topic/${esc(a.key)}">${esc(a.label)}</a>`).join('')}</div>` : '';
    return `<header class="topic-head qt-head">
        <p class="kicker"><a href="#quotes">Who said what</a></p>
        <div class="ol-title"><span class="qt-mono big" aria-hidden="true">${esc(initials(p.name))}</span><h1>${esc(p.name)}</h1></div>
        ${p.roles.length ? `<p class="topic-sum">${p.roles.map(esc).join(' · ')}</p>` : ''}
        ${about}
        <div class="ol-btns"><a class="chip" href="#search?q=${encodeURIComponent(`"${p.name}"`)}">Search coverage</a><a class="chip" href="#graph">Connections</a></div>
      </header>
      <ul class="ss-tiles">${tiles.map(([b, s], i) => `<li style="--i:${i}"><b>${b}</b><span>${s}</span></li>`).join('')}</ul>
      <div class="dy-grid">
        <div>
          <section class="topic-card"><h2>Quotes per day<small>last ${p.days} days</small></h2><div class="tr-plot">${dailyChart(p, animate)}</div></section>
          ${p.predictions?.length ? `<section class="qt-lines"><h2 class="when">Their predictions<span><a href="#predictions?who=${esc(p.key)}">all of them</a></span></h2><ol class="pd-list">${p.predictions.map((f) => `<li class="pd-card"><p class="pd-who"><em>Due ${f.year}</em></p><p class="pd-text">${esc(f.text)}</p><p class="qt-src"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a> · ${ago(f.at)}</p></li>`).join('')}</ol></section>` : ''}
          <section class="qt-lines"><h2 class="when">In their words<span>${p.lines.length < t.lines ? `latest ${p.lines.length} of ${t.lines}` : t.lines}</span></h2><ol class="qt-wall one${animate ? ' animate' : ''}">${p.lines.map((l, i) => pull(l, i, { person: false })).join('')}</ol></section>
        </div>
        <aside>${where}${along}</aside>
      </div>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    const host = $('#quotesView');
    if (state.mode !== 'api') {
      setHtml(host, '<header class="topic-head"><h1>Who said what</h1></header><p class="rail-note">Quotes need the live server.</p>');
      return;
    }
    if (view.key) {
      loadPerson(view.key);
      const hit = people.get(view.key);
      document.title = `${hit?.d?.name || 'Person'} · Who said what · ${name}`;
      if (!hit?.d) {
        setHtml(host, `<header class="topic-head"><p class="kicker"><a href="#quotes">Who said what</a></p>${hit?.error ? `<h1>Not quoted lately</h1><p class="topic-sum">${esc(hit.error)}</p>` : '<i class="skeleton sk-title"></i><i class="skeleton"></i>'}</header>`);
        return;
      }
      const animate = drawn !== hit.d && !reducedMotion();
      drawn = hit.d;
      setHtml(host, `${personPage(hit.d, animate)}<div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
      return;
    }
    document.title = `Who said what · ${name}`;
    const q = view.find.trim().toLowerCase();
    loadList(q);
    // While a filter loads, the last list stays up.
    const hit = lists.get(q) || {};
    if (hit.d) lastQ = q;
    const shown = hit.d || lists.get(lastQ)?.d;
    const head = `<header class="topic-head">
        <p class="kicker">People</p>
        <h1>Who said what</h1>
        <p class="topic-sum">Direct quotes from AI coverage, attributed by name: the lines the most outlets carried this week, and everyone being quoted, with what they talk about.</p>
      </header>`;
    if (!shown) {
      setHtml(host, `${head}${hit.error ? `<p class="rail-note">Quotes are unavailable: ${esc(hit.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const animate = drawn !== shown && !reducedMotion() && !q;
    drawn = shown;
    const focused = document.activeElement?.id === 'qtFind';
    setHtml(host, `${head}${directory(shown, animate)}`);
    if (focused) {
      const el = $('#qtFind');
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function onInput(e) {
    if (e.target.id !== 'qtFind') return false;
    view.find = e.target.value;
    clearTimeout(typing);
    typing = setTimeout(render, 250);
    return true;
  }

  function hover(e) {
    const svg = $('#quotesView svg[data-chart="qtdaily"]');
    if (!svg || !charts.qtdaily) return;
    const on = e.type !== 'pointerleave' && e.target.closest?.('svg[data-chart="qtdaily"]');
    const i = on ? pointAt(svg, charts.qtdaily.meta, e.clientX) : -1;
    showPoint(svg, charts.qtdaily.meta, i, $('#quotesView .tr-tip'), $('#quotesView'), i < 0 ? '' : charts.qtdaily.tip(i), setHtml);
  }

  return { route, render, onInput, hover };
}
