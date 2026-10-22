// Any day (#day, #day/2026-03-10): a calendar of the last year, one square
// per day shaded by how much was published, and the front page of the chosen
// day rebuilt from the archive: its top stories, the names in the news far
// more than usual, deals, releases, the markets that moved and the most-liked
// X posts. ← and → step through days. Server side: src/index/day.js.

import { money } from './deals.js';

const CELL = 11;
const GAP = 2;
const STEPS = [18, 38, 58, 78, 100]; // % of the series colour over the surface

const DAY = 86400e3;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const parse = (s) => Date.parse(`${s}T00:00:00Z`);
const long = (s) => new Date(parse(s)).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const short = (s) => new Date(parse(s)).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const clock = (t) => new Date(t).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;

// Quantile breaks over the days that have anything, so a year of crawl growth
// doesn't paint every early day the palest step.
export function levels(counts) {
  const xs = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (!xs.length) return () => 0;
  const cut = [0.2, 0.4, 0.6, 0.8].map((q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]);
  return (n) => (n <= 0 ? 0 : 1 + cut.filter((c) => n > c).length);
}

export function createDay({ $, esc, setHtml, state, reducedMotion }) {
  const view = { day: null };
  let cal = null; // { d, error, pending, at }
  const days = new Map(); // day -> { d, error, pending, at }
  let shown = null;
  let lastDay = null;

  const today = () => dayOf(Date.now());
  const yesterday = () => dayOf(Date.now() - DAY);

  function route(hash) {
    const m = /^#day(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(hash);
    if (!m) return null;
    const d = m[1] && !Number.isNaN(parse(m[1])) && m[1] <= today() ? m[1] : yesterday();
    view.day = d;
    return 'day';
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }

  async function loadCal() {
    if (cal?.pending || cal?.d || (cal?.error && Date.now() - cal.at < 20e3)) return;
    cal = { pending: true };
    try {
      cal = { d: await fetchJson('/api/days'), at: Date.now() };
    } catch (err) {
      cal = { error: err.message, at: Date.now() };
    }
    if (state.view === 'day') render();
  }

  async function loadDay(day) {
    const hit = days.get(day);
    if (hit?.pending || (hit?.d && (day !== today() || Date.now() - hit.at < 5 * 60e3)) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    days.set(day, { ...hit, pending: true });
    try {
      days.set(day, { d: await fetchJson(`/api/day?d=${day}`), at: Date.now() });
      if (days.size > 30) days.delete(days.keys().next().value);
    } catch (err) {
      days.set(day, { error: err.message, at: Date.now() });
    }
    if (state.view === 'day' && view.day === day) render();
  }

  // ---- Calendar ----

  function calendar(c) {
    const first = parse(c.days[0].day);
    // Columns are Monday-started weeks.
    const lead = (new Date(first).getUTCDay() + 6) % 7;
    const level = levels(c.days.map((x) => x.n));
    const cols = Math.ceil((lead + c.days.length) / 7);
    const L = 28, T = 16;
    const W = L + cols * (CELL + GAP);
    const H = T + 7 * (CELL + GAP);
    let months = '';
    let lastCol = -9;
    const cells = c.days.map((x, i) => {
      const k = lead + i;
      const col = Math.floor(k / 7), row = k % 7;
      // A month is labelled over the column holding its 1st, if there's room.
      if (x.day.endsWith('-01') && col - lastCol >= 3 && col < cols - 1) {
        months += `<text class="dy-m" x="${L + col * (CELL + GAP)}" y="10">${new Date(parse(x.day)).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' })}</text>`;
        lastCol = col;
      }
      const lv = level(x.n);
      const sel = x.day === view.day ? ' sel' : '';
      return `<a href="#day/${x.day}" aria-label="${short(x.day)}: ${x.n.toLocaleString()} items" data-dyd="${x.day}" data-dyn="${x.n}"><rect class="dy-c l${lv}${sel}" x="${L + col * (CELL + GAP)}" y="${T + row * (CELL + GAP)}" width="${CELL}" height="${CELL}" rx="2" style="--k:${col}"/></a>`;
    }).join('');
    const rows = ['Mon', '', 'Wed', '', 'Fri', '', ''].map((d, r) => (d ? `<text class="dy-w" x="0" y="${T + r * (CELL + GAP) + CELL - 2}">${d}</text>` : '')).join('');
    const legend = `<p class="dy-legend" aria-hidden="true"><span>Fewer</span>${[0, 1, 2, 3, 4, 5].map((l) => `<i class="dy-c l${l}"></i>`).join('')}<span>More</span></p>`;
    return `<section class="topic-card dy-cal"><h2>The last year<small>items stored per day (UTC)</small></h2>
      <div class="dy-scroll"><svg class="dy-heat draw" viewBox="0 0 ${W} ${H}" style="--w:${W}px" role="img" aria-label="Items stored per day over the last year; choose a day to open it">${months}${rows}${cells}</svg></div>${legend}</section>`;
  }

  // ---- The day ----

  function tiles(t) {
    const items = [
      [t.stories, t.stories === 1 ? 'story' : 'stories'],
      [t.articles, t.articles === 1 ? 'article' : 'articles'],
      [t.outlets, t.outlets === 1 ? 'outlet' : 'outlets'],
      [t.posts, t.posts === 1 ? 'post on X' : 'posts on X'],
    ];
    return `<ul class="ss-tiles dy-tiles">${items.map(([b, s], i) => `<li style="--i:${i}"><b>${b.toLocaleString()}</b><span>${s}</span></li>`).join('')}</ul>`;
  }

  function story(s, i) {
    const more = s.items.length ? `<details class="dy-more"><summary>${s.items.length} more ${s.items.length === 1 ? 'report' : 'reports'}</summary><ul>${s.items.map((it) => `<li><img src="${esc(fav(it.host))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a> <small>${esc(it.source)} · ${clock(it.at)}</small></li>`).join('')}</ul></details>` : '';
    const tags = s.entities.length ? `<span class="dy-tags">${s.entities.map((e) => `<a href="#topic/${esc(e.key)}">${esc(e.label)}</a>`).join('')}</span>` : '';
    const lead = i === 0 && s.image;
    return `<li class="dy-story${lead ? ' lead' : ''}" style="--i:${i}">
      ${lead ? `<img class="dy-img" src="${esc(s.image)}" alt="" loading="lazy" data-fallback="remove">` : `<span class="dy-n">${i + 1}</span>`}
      <div>
        <a class="dy-h" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
        ${i < 3 && s.summary ? `<p class="dy-sum">${esc(s.summary)}</p>` : ''}
        <p class="dy-meta"><img src="${esc(fav(s.host))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(s.source)} · ${clock(s.at)} UTC${s.outlets > 1 ? ` · <b>${s.outlets} outlets</b>` : ''}${tags}</p>
        ${more}
      </div></li>`;
  }

  function names(d) {
    if (!d.names.length) return '';
    const max = Math.max(...d.names.map((x) => x.lift));
    return `<section class="dy-side"><h2 class="when">Far more than usual</h2><ol class="dy-names">${d.names.map((x, i) => `<li style="--i:${i}">
      <a href="#topic/${esc(x.key)}">${esc(x.label)}</a>
      <span class="dy-bar" title="${(x.share * 100).toFixed(1)}% of articles, against ${(x.base * 100).toFixed(1)}% in the four weeks before"><i style="width:${Math.max(4, (x.lift / max) * 100).toFixed(1)}%"></i></span>
      <b>${x.lift >= 10 ? Math.round(x.lift) : x.lift.toFixed(1)}×</b><small>${x.n} articles</small></li>`).join('')}</ol>
      <p class="rail-note">Share of the day’s articles naming each, against the four weeks before.</p></section>`;
  }

  function deals(d) {
    if (!d.deals.length) return '';
    return `<section class="dy-side"><h2 class="when">Deals</h2><ul class="dy-list">${d.deals.map((x) => {
      const what = x.kind === 'acquisition' ? `${x.acquirer ? `${esc(x.acquirer)} buys` : 'Acquired:'} ${esc(x.company)}` : `${esc(x.company)}${x.kind === 'valuation' ? ' valued' : ` ${esc(x.round || 'raises')}`}`;
      const amt = x.kind === 'valuation' ? money(x.valuation) : x.amount ? money(x.amount) : '';
      return `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${what}</a>${amt ? `<b>${amt}</b>` : ''}<small>${esc(x.site)}${x.outlets > 1 ? ` +${x.outlets - 1}` : ''}${x.talks ? ' · in talks' : ''}</small></li>`;
    }).join('')}</ul><a class="tr-link" href="#deals?c=${encodeURIComponent(d.deals[0].companyKey)}">Open in Deals →</a></section>`;
  }

  function releases(d) {
    if (!d.releases?.length) return '';
    return `<section class="dy-side"><h2 class="when">Released</h2><ul class="dy-list">${d.releases.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a><small>${esc(r.provider || '')}${r.open ? ' · open weights' : ''}</small></li>`).join('')}</ul></section>`;
  }

  function moves(d) {
    if (!d.moves?.length) return '';
    return `<section class="dy-side"><h2 class="when">Markets that moved</h2><ul class="dy-list dy-moves">${d.moves.map((m) => {
      const up = m.delta > 0;
      const pct = (v) => `${Math.round(v * 100)}%`;
      return `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a><small>${m.binary ? '' : `${esc(m.outcome)} · `}${pct(m.from)} → <b class="${up ? 'up' : 'down'}">${pct(m.to)}</b> <span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(m.delta * 100))} pts</span></small></li>`;
    }).join('')}</ul></section>`;
  }

  function posts(d) {
    if (!d.posts.length) return '';
    return `<section class="dy-side"><h2 class="when">Most liked on X</h2><ul class="dy-posts">${d.posts.map((p) => `<li>${p.avatar ? `<img src="${esc(p.avatar)}" alt="" width="24" height="24" loading="lazy" data-fallback="remove">` : '<i class="dy-av" aria-hidden="true"></i>'}<div><p><a href="#account/${esc(p.handle)}">@${esc(p.handle)}</a> <small>${clock(p.at)}</small></p><a class="dy-post" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.text)}</a></div></li>`).join('')}</ul></section>`;
  }

  function nav(d) {
    const min = cal?.d?.from || '2000-01-01';
    const prev = d?.prev || (view.day > min ? dayOf(parse(view.day) - DAY) : null);
    const next = d ? d.next : view.day < today() ? dayOf(parse(view.day) + DAY) : null;
    return `<nav class="dy-nav" aria-label="Days">
      ${prev ? `<a class="chip" href="#day/${prev}" data-dydir="-1" rel="prev"><span aria-hidden="true">←</span> ${short(prev)}</a>` : '<span></span>'}
      <label class="visually-hidden" for="dyPick">Go to a day</label>
      <input id="dyPick" type="date" min="${min}" max="${today()}" value="${view.day}">
      ${next ? `<a class="chip" href="#day/${next}" data-dydir="1" rel="next">${short(next)} <span aria-hidden="true">→</span></a>` : '<span></span>'}
    </nav>`;
  }

  function edition(d, dir) {
    if (!d.totals.items) return `<div class="dy-edition"><p class="rail-note">Nothing about AI was stored for ${long(d.day)}.</p></div>`;
    const side = `${names(d)}${deals(d)}${releases(d)}${moves(d)}${posts(d)}`;
    return `<div class="dy-edition${dir ? ` from-${dir > 0 ? 'r' : 'l'}` : ''}" data-id="dy-${d.day}">
      ${tiles(d.totals)}
      <div class="dy-grid${side ? '' : ' solo'}">
        <section><h2 class="when">Front page${d.partial ? '<span>so far</span>' : ''}</h2><ol class="dy-stories">${d.top.map(story).join('')}</ol></section>
        ${side ? `<aside>${side}</aside>` : ''}
      </div></div>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `${long(view.day)} · Any day · ${name}`;
    const head = `<header class="topic-head dy-head">
        <p class="kicker">Archive · Any day</p>
        <h1>${long(view.day)}</h1>
        <p class="topic-sum">The AI news of any day in the last year, rebuilt from the archive: what most outlets ran, what was named far more than usual, deals, releases and the markets that moved.</p>
      </header>`;
    if (state.mode !== 'api') {
      setHtml($('#dayView'), `${head}<p class="rail-note">Past days need the live server.</p>`);
      return;
    }
    loadCal();
    loadDay(view.day);
    const calHtml = cal?.d ? calendar(cal.d) : cal?.error ? '' : '<section class="topic-card dy-cal"><div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div></section>';
    const hit = days.get(view.day);
    let body;
    if (hit?.d) {
      const d = hit.d;
      const fresh = shown !== d && !reducedMotion();
      const dir = fresh && lastDay && lastDay !== d.day ? (d.day > lastDay ? 1 : -1) : 0;
      body = edition(d, fresh ? dir || 0.5 : 0);
      shown = d;
      lastDay = d.day;
    } else {
      body = hit?.error ? `<p class="rail-note">That day is unavailable: ${esc(hit.error)}</p>` : `<div class="dy-edition" aria-busy="true"><ul class="ss-tiles dy-tiles">${'<li><i class="skeleton"></i></li>'.repeat(4)}</ul>${[90, 76, 84, 70, 80].map((w) => `<i class="skeleton" style="width:${w}%;height:18px;margin:12px 0;display:block"></i>`).join('')}</div>`;
    }
    const scroller = $('#dayView .dy-scroll');
    const keep = scroller ? scroller.scrollLeft : null;
    setHtml($('#dayView'), `${head}${calHtml}${nav(hit?.d)}${body}<div class="ac-tip dy-tip" role="tooltip" hidden></div>`);
    // The calendar opens on the latest weeks, or where it was.
    const sc = $('#dayView .dy-scroll');
    if (sc) sc.scrollLeft = keep ?? sc.scrollWidth;
  }

  function onChange(e) {
    if (e.target.id !== 'dyPick' || !e.target.value) return false;
    location.hash = `#day/${e.target.value}`;
    return true;
  }

  // ← and → step through days.
  function onKey(e) {
    if (state.view !== 'day' || e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(document.activeElement?.tagName)) return false;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    const a = $(`#dayView .dy-nav [data-dydir="${e.key === 'ArrowLeft' ? -1 : 1}"]`);
    if (!a) return false;
    e.preventDefault();
    location.hash = a.getAttribute('href');
    return true;
  }

  function hover(e) {
    const tip = $('#dayView .dy-tip');
    const a = e.type === 'pointerleave' ? null : e.target.closest?.('[data-dyd]');
    if (!tip) return;
    if (!a) { tip.hidden = true; return; }
    const host = $('#dayView').getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const n = +a.dataset.dyn;
    setHtml(tip, `<p class="tt-h">${short(a.dataset.dyd)}</p><p><b>${n.toLocaleString()}</b> ${n === 1 ? 'item' : 'items'} stored</p>`);
    tip.hidden = false;
    const w = tip.offsetWidth;
    const x = Math.min(Math.max(8, r.left - host.left + r.width / 2 - w / 2), host.width - w - 8);
    tip.style.transform = `translate(${x}px, ${r.top - host.top - tip.offsetHeight - 8}px)`;
  }

  return { route, render, onChange, onKey, hover };
}
