// Storylines (#storylines, #storyline/<id>): stories that keep coming back
// over days and weeks, as swimlanes on one shared timeline, and a page per
// storyline that tells it chapter by chapter.
// Server side: src/index/storylines.js.

import { barChart, pointAt, showPoint } from './charts.js';

const DAY = 86400e3;
const WINDOW = 28; // days on the timeline (half on phones)
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const short = (d) => new Date(dayMs(d)).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const long = (d) => new Date(dayMs(d)).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const quiet = (n) => (n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`);

export function createStorylines({ $, esc, setHtml, state, reducedMotion }) {
  const view = { id: null, filter: 'all' };
  let list = null; // { d, error, pending, at }
  const pages = new Map(); // id -> { d, error, pending, at }
  let charts = {};
  let drawn = null;

  function route(hash) {
    if (hash === '#storylines') {
      view.id = null;
      return 'storylines';
    }
    const m = /^#storyline\/([a-f0-9]{10})$/.exec(hash);
    if (!m) return null;
    view.id = m[1];
    return 'storylines';
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }

  async function loadList() {
    if (list?.pending || (list?.d && Date.now() - list.at < 10 * 60e3) || (list?.error && Date.now() - list.at < 20e3)) return;
    list = { ...list, pending: true };
    try {
      list = { d: await fetchJson('/api/storylines'), at: Date.now() };
    } catch (err) {
      list = { d: list.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'storylines' && !view.id) render();
  }

  async function loadOne(id) {
    const hit = pages.get(id);
    if (hit?.pending || hit?.d || (hit?.error && Date.now() - hit.at < 20e3)) return;
    pages.set(id, { pending: true });
    try {
      pages.set(id, { d: await fetchJson(`/api/storyline?id=${id}`), at: Date.now() });
    } catch (err) {
      pages.set(id, { error: err.message, at: Date.now() });
    }
    if (state.view === 'storylines' && view.id === id) render();
  }

  // ---- The timeline ----

  // Every lane shares one x scale, from the first shown storyline's start to
  // today but no more than four weeks (two on a phone), so recent days aren't squeezed; a line
  // that began earlier fades in from the left edge.
  function lanes(rows, d, animate) {
    const to = dayMs(d.to);
    const days = innerWidth < 640 ? WINDOW / 2 : WINDOW;
    const from = Math.max(Math.min(...rows.map((s) => dayMs(s.from))), to - (days - 1) * DAY);
    const span = Math.max(DAY, to - from);
    const x = (day) => Math.max(0, ((dayMs(day) - from) / span) * 100).toFixed(2);
    // Month starts and Mondays as ticks, thinned to about six.
    const ticks = [];
    for (let t = from; t <= to; t += DAY) if (new Date(t).getUTCDay() === 1) ticks.push(t);
    const step = Math.ceil(ticks.length / 6);
    const axis = ticks.filter((t, i) => i % step === 0 && to - t > span * 0.16).map((t) => `<span style="left:${(((t - from) / span) * 100).toFixed(2)}%">${short(new Date(t).toISOString().slice(0, 10))}</span>`).join('');
    const max = Math.max(...rows.flatMap((s) => s.daily.map((p) => p.n)));
    const r = (n) => (4 + Math.sqrt(n / max) * 6).toFixed(1);
    const items = rows.map((s, i) => {
      const dots = s.daily.filter((p) => dayMs(p.day) >= from).map((p, j) => `<i class="sl-dot${p.day === s.to && s.active ? ' live' : ''}" style="left:${x(p.day)}%;--r:${r(p.n)}px;--d:${j}" data-sltip="${esc(`${long(p.day)} · ${plural(p.n, 'report')}`)}"></i>`).join('');
      return `<li style="--i:${Math.min(i, 16)}">
        <a class="sl-row" href="#storyline/${s.id}">
          <span class="sl-label">
            <b>${esc(s.title)}</b>
            <small>${s.active ? '<em class="sl-live">Developing</em>' : `Quiet since ${short(s.to)}`} · ${plural(s.dayCount, 'day')} · ${plural(s.outlets, 'report')}</small>
          </span>
          <span class="sl-lane" aria-label="${esc(`${plural(s.dayCount, 'day')} of coverage, ${short(s.from)} to ${short(s.to)}`)}">
            <b class="sl-span${dayMs(s.from) < from ? ' cut' : ''}" style="left:${x(s.from)}%;width:${(x(s.to) - x(s.from)).toFixed(2)}%"></b>${dots}
          </span>
        </a>
        <p class="sl-latest"><span>Latest</span> <a href="${esc(s.latest.url)}" target="_blank" rel="noopener">${esc(s.latest.title)}</a> <small>${esc(s.latest.source)} · ${quiet(s.daysAgo)}</small></p>
      </li>`;
    }).join('');
    return `<div class="sl-board${animate ? ' animate' : ''}">
      <p class="sl-axis" aria-hidden="true"><span class="sl-axis-pad"></span><span class="sl-axis-ticks">${axis}<span class="sl-today" style="left:100%">Today</span></span></p>
      <ol class="sl-list">${items}</ol></div>`;
  }

  function directory(d, animate) {
    const rows = d.storylines.filter((s) => view.filter === 'all' || s.active);
    const active = d.storylines.filter((s) => s.active).length;
    const chips = [['all', `All ${d.storylines.length}`], ['active', `Developing ${active}`]].map(([k, l]) => `<button type="button" class="chip" data-slfilter="${k}" aria-pressed="${view.filter === k}">${l}</button>`).join('');
    return `<section class="sl-dir">
        <div class="dl-tools"><h2 class="when">The last ${d.days} days</h2><div class="chips">${chips}</div></div>
        ${rows.length ? lanes(rows, d, animate) : '<p class="rail-note">Nothing is developing right now.</p>'}
        <p class="sl-key" aria-hidden="true"><i class="sl-dot"></i> a day with coverage, sized by reports <i class="sl-dot live"></i> new today or yesterday</p>
      </section>`;
  }

  // ---- One storyline ----

  function coverage(s, animate) {
    const days = [];
    for (let t = dayMs(s.from); t <= dayMs(s.to); t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
    const by = new Map(s.daily.map((p) => [p.day, p.n]));
    const top = new Map();
    for (const c of s.chapters) if (!top.has(c.day) || top.get(c.day).outlets < c.outlets) top.set(c.day, c);
    const narrow = innerWidth < 640;
    const xs = days.map(dayMs);
    const values = days.map((d) => by.get(d) || 0);
    const { svg, meta } = barChart({ id: 'slcov', xs, stacks: [{ key: 'n', label: 'Reports', color: 'var(--s1c)', values }], W: narrow ? 380 : 760, H: narrow ? 160 : 180, animate, xFmt: (t) => short(new Date(t).toISOString().slice(0, 10)), label: `Reports per day, ${short(s.from)} to ${short(s.to)}` });
    charts.slcov = { meta, tip: (i) => `<p class="tt-h">${long(days[i])}</p><p><b>${values[i]}</b> ${values[i] === 1 ? 'report' : 'reports'}</p>${top.get(days[i]) ? `<p class="tt-sub">${esc(top.get(days[i]).title)}</p>` : ''}` };
    return svg;
  }

  function chapters(s, animate) {
    const byDay = new Map();
    for (const c of s.chapters) {
      if (!byDay.has(c.day)) byDay.set(c.day, []);
      byDay.get(c.day).push(c);
    }
    let prev = null;
    let i = 0;
    const out = [];
    for (const [day, cs] of byDay) {
      const gap = prev ? Math.round((dayMs(day) - dayMs(prev)) / DAY) - 1 : 0;
      if (gap > 0) out.push(`<li class="sl-gap" aria-hidden="true"><span>${plural(gap, 'quiet day')}</span></li>`);
      prev = day;
      const n = cs.reduce((a, c) => a + c.outlets, 0);
      cs.sort((a, b) => b.outlets - a.outlets);
      out.push(`<li class="sl-day" style="--i:${Math.min(i++, 14)}">
        <h3><time datetime="${day}">${long(day)}</time><small>${plural(n, 'report')}</small></h3>
        <ul>${cs.map((c) => `<li>
          <a class="sl-hl" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>
          <span class="sl-meta"><img src="${esc(fav(hostOf(c.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(c.source)}${c.outlets > 1 ? ` and ${plural(c.outlets - 1, 'other')}` : ''}</span>
          ${c.items.length ? `<span class="sl-also">${c.items.map((it) => `<a href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.title)}">${esc(it.source)}</a>`).join('')}</span>` : ''}
        </li>`).join('')}</ul></li>`);
    }
    return `<ol class="sl-chapters${animate ? ' animate' : ''}">${out.join('')}</ol>`;
  }

  function page(s, animate) {
    charts = {};
    const biggest = [...s.daily].sort((a, b) => b.n - a.n)[0];
    const tiles = [
      [s.dayCount, `days with coverage between ${short(s.from)} and ${short(s.to)}`],
      [s.chapterCount, 'separate stories'],
      [s.outlets, 'reports in all'],
      [short(biggest.day), `its biggest day, ${plural(biggest.n, 'report')}`],
    ];
    const q = encodeURIComponent(s.title);
    return `<header class="topic-head sl-head${s.image ? ' has-image' : ''}">
        <div>
          <p class="kicker"><a href="#storylines">Storylines</a> · ${s.active ? '<em class="sl-live">Developing</em>' : `quiet since ${short(s.to)}`}</p>
          <h1>${esc(s.title)}</h1>
          <p class="topic-sum">Latest: <a href="${esc(s.latest.url)}" target="_blank" rel="noopener">${esc(s.latest.title)}</a> · ${esc(s.latest.source)}, ${quiet(s.daysAgo)}</p>
          <div class="ol-btns">${s.entities.map((e) => `<a class="chip" href="#topic/${esc(e.key)}">${esc(e.label)}</a>`).join('')}<a class="chip" href="#ask?q=${q}">Ask the Wire</a></div>
        </div>
        ${s.image ? `<img class="story-hero" src="${esc(s.image)}" alt="" loading="lazy" data-fallback="remove">` : ''}
      </header>
      <ul class="ss-tiles">${tiles.map(([b, t], i) => `<li style="--i:${i}"><b>${b}</b><span>${t}</span></li>`).join('')}</ul>
      <section class="topic-card"><h2>Reports per day<small>every outlet’s copy of each chapter</small></h2><div class="tr-plot">${coverage(s, animate)}</div></section>
      <section class="topic-card sl-story"><h2>Chapter by chapter<small>oldest first; the biggest story of each day leads</small></h2>${chapters(s, animate)}</section>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    if (state.mode !== 'api') {
      setHtml($('#storylinesView'), '<header class="topic-head"><h1>Storylines</h1></header><p class="rail-note">Storylines need the live server.</p>');
      return;
    }
    if (view.id) {
      loadOne(view.id);
      const hit = pages.get(view.id);
      document.title = `${hit?.d?.title || 'Storyline'} · ${name}`;
      if (!hit?.d) {
        setHtml($('#storylinesView'), `<header class="topic-head"><p class="kicker"><a href="#storylines">Storylines</a></p>${hit?.error ? `<h1>Storyline not found</h1><p class="topic-sum">${esc(hit.error)}</p>` : '<i class="skeleton sk-title"></i><i class="skeleton"></i>'}</header>`);
        return;
      }
      const animate = drawn !== hit.d && !reducedMotion();
      drawn = hit.d;
      setHtml($('#storylinesView'), `${page(hit.d, animate)}<div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
      return;
    }
    document.title = `Storylines · ${name}`;
    loadList();
    const head = `<header class="topic-head">
        <p class="kicker">Over time</p>
        <h1>Storylines</h1>
        <p class="topic-sum">Stories that keep coming back. Each day’s coverage is grouped into stories, and stories on different days are strung together when they are about the same thing: the arrest, then the hearing, then the court filing.</p>
      </header>`;
    if (!list?.d) {
      setHtml($('#storylinesView'), `${head}${list?.error ? `<p class="rail-note">Storylines are unavailable: ${esc(list.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const animate = drawn !== list.d && !reducedMotion();
    drawn = list.d;
    setHtml($('#storylinesView'), `${head}${directory(list.d, animate)}<div class="ac-tip sl-tip" role="tooltip" hidden></div>`);
  }

  function onClick(t) {
    if (t.dataset.slfilter) {
      view.filter = t.dataset.slfilter;
      drawn = null;
      render();
      return true;
    }
    return false;
  }

  // Chart crosshair on a storyline page; dot tooltips on the timeline.
  function hover(e) {
    const host = $('#storylinesView');
    const dot = e.type !== 'pointerleave' && e.target.closest?.('[data-sltip]');
    const tip = $('#storylinesView .sl-tip');
    if (tip) {
      if (!dot) { tip.hidden = true; return; }
      setHtml(tip, `<p>${esc(dot.dataset.sltip)}</p>`);
      const a = dot.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${Math.min(b.width - tip.offsetWidth - 4, Math.max(4, a.left - b.left + a.width / 2 - tip.offsetWidth / 2))}px`;
      tip.style.top = `${a.top - b.top - tip.offsetHeight - 8}px`;
      return;
    }
    const svg = $('#storylinesView svg[data-chart="slcov"]');
    if (!svg || !charts.slcov) return;
    const on = e.type !== 'pointerleave' && e.target.closest?.('svg[data-chart="slcov"]');
    const i = on ? pointAt(svg, charts.slcov.meta, e.clientX) : -1;
    showPoint(svg, charts.slcov.meta, i, $('#storylinesView .tr-tip'), host, i < 0 ? '' : charts.slcov.tip(i), setHtml);
  }

  return { route, render, onClick, hover };
}
