// Catch-up (#catchup): everything since a reader was last here — the
// biggest stories (each with a strip of when its coverage landed), breaking
// alerts, storylines that moved on, markets that moved after the news,
// releases, names suddenly everywhere, deals and X posts. The front page
// offers it when a reader comes back after a few hours away.
// Server side: src/index/catchup.js.

import { barChart, pointAt, showPoint } from './charts.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const AWAY = 3 * HOUR; // gone this long, the front page offers a catch-up
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const clock = (t) => new Date(t).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
const when = (t) => new Date(t).toLocaleString('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const pct = (v) => `${Math.round(v * 100)}%`;
const money = (v) => (v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${v}`);
export function span(ms) {
  const h = Math.round(ms / HOUR);
  if (h < 1) return 'under an hour';
  if (h < 36) return plural(h, 'hour');
  return plural(Math.round(ms / DAY), 'day');
}
const PRESETS = [[6, '6 hours'], [12, '12 hours'], [24, 'A day'], [72, '3 days'], [168, 'A week']];

export function createCatchup({ $, esc, setHtml, state, reducedMotion, store }) {
  // The last time this browser had the site open, before this visit.
  const now0 = Date.now();
  let away = 0;
  try { away = Number(sessionStorage.getItem('fw.away')) || 0; } catch { /* storage blocked */ }
  if (!away) {
    const seen = Number(store.get('fw.seen', 0)) || 0;
    if (seen && now0 - seen >= AWAY && now0 - seen < 30 * DAY) {
      away = seen;
      try { sessionStorage.setItem('fw.away', String(seen)); } catch { /* storage blocked */ }
    }
  }
  const markSeen = () => store.set('fw.seen', Date.now());
  markSeen();
  setInterval(() => { if (document.visibilityState === 'visible') markSeen(); }, 60e3);
  addEventListener('pagehide', markSeen);

  const view = { since: 0 };
  const cache = new Map(); // since -> { d, error, pending, at }
  let chart = null;
  let drawn = null;

  function route(hash) {
    const m = /^#catchup(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    const h = Number(p.get('h'));
    const s = Number(p.get('since'));
    view.since = s > 0 ? s : Date.now() - (h > 0 ? h : away ? (Date.now() - away) / HOUR : 24) * HOUR;
    view.hours = h > 0 ? h : 0;
    view.last = !h && (s > 0 ? Math.abs(s - away) < 60e3 : !!away);
    return 'catchup';
  }

  // Requests snap to the quarter hour, as the server does, so they share a cache.
  const snapped = (t) => Math.floor(t / (15 * 60e3)) * 15 * 60e3;

  async function load(since) {
    const hit = cache.get(since);
    if (hit?.pending || (hit?.d && Date.now() - hit.at < 2 * 60e3) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    cache.set(since, { ...hit, pending: true });
    try {
      const r = await fetch(`/api/catchup?since=${since}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(since, { d, at: Date.now() });
    } catch (err) {
      cache.set(since, { d: hit?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'catchup' && snapped(view.since) === since) render();
  }

  // The front page's welcome back: how long it's been, and a way in.
  function welcome() {
    const el = $('#welcomeBack');
    if (!el) return;
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('fw.awayDone') === '1'; } catch { /* storage blocked */ }
    if (!away || dismissed || state.mode !== 'api') {
      el.hidden = true;
      return;
    }
    if (!el.hidden && el.dataset.away === String(away)) return;
    el.dataset.away = String(away);
    setHtml(el, `<a class="wb-go" href="#catchup?since=${away}"><span class="wb-k">Welcome back</span><span class="wb-t">You were away ${esc(span(Date.now() - away))}. See what happened since ${esc(when(away))}</span><span class="wb-arrow" aria-hidden="true">→</span></a><button class="wb-x" type="button" aria-label="Dismiss">×</button>`);
    el.hidden = false;
  }

  function onWelcomeClick(e) {
    if (!e.target.closest('.wb-x')) return;
    try { sessionStorage.setItem('fw.awayDone', '1'); } catch { /* storage blocked */ }
    $('#welcomeBack').hidden = true;
  }

  // When a story's coverage landed across the window: a dot per report.
  function strip(times, since, now) {
    const W = 120, H = 14, x = (t) => 3 + ((t - since) / Math.max(1, now - since)) * (W - 6);
    const dots = times.map((t) => `<circle cx="${x(t).toFixed(1)}" cy="7" r="2.5"/>`).join('');
    return `<svg class="cu-strip" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${times.length} reports between ${esc(clock(times[0]))} and ${esc(clock(times[times.length - 1]))}"><line x1="3" x2="${W - 3}" y1="7" y2="7"/>${dots}</svg>`;
  }

  function story(s, i, d) {
    const href = s.sid ? `#story/${encodeURIComponent(s.sid)}` : s.url;
    const ext = s.sid ? '' : ' target="_blank" rel="noopener"';
    const tags = s.entities.length ? `<span class="dy-tags">${s.entities.map((e) => `<a href="#topic/${esc(e.key)}">${esc(e.label)}</a>`).join('')}</span>` : '';
    return `<li class="dy-story cu-story" style="--i:${i}">
      <span class="dy-n">${i + 1}</span>
      <div>
        <a class="dy-h" href="${esc(href)}"${ext}>${esc(s.title)}</a>
        ${i < 2 && s.summary ? `<p class="dy-sum">${esc(s.summary)}</p>` : ''}
        <p class="dy-meta"><img src="${esc(fav(hostOf(s.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(s.source)}${s.outlets > 1 ? ` · <b>${s.outlets} outlets</b>` : ''}${s.posts ? ` · ${plural(s.posts, 'X post')}` : ''}${s.continuing ? ' · <em class="cu-cont">kept going</em>' : ''}${tags}</p>
      </div>
      ${s.times.length > 1 ? strip(s.times, d.since, d.generatedAt) : ''}
    </li>`;
  }

  function activityChart(d, animate) {
    const pts = d.activity.points;
    if (!pts.length) return '';
    const narrow = innerWidth < 640;
    const xs = pts.map((p) => p.t);
    const hourly = d.activity.bucket < DAY;
    const fmt = (t) => (d.generatedAt - d.since > 30 * HOUR ? new Date(t).toLocaleDateString('en', { weekday: 'short' }) : clock(t));
    const every = Math.ceil(pts.length / (narrow ? 4 : 7));
    const xTicks = xs.map((_, i) => i).filter((i) => i % every === 0);
    const { svg, meta } = barChart({ id: 'cuact', xs, W: narrow ? 380 : 760, H: narrow ? 150 : 170, animate, xTicks, xFmt: fmt, label: 'Articles and X posts over the window',
      stacks: [{ key: 'a', label: 'Articles', color: 'var(--s1c)', values: pts.map((p) => p.articles) }, { key: 'p', label: 'X posts', color: 'var(--s2c)', values: pts.map((p) => p.posts) }] });
    const size = d.activity.bucket / HOUR;
    chart = { meta, tip: (i) => `<p class="tt-h">${hourly ? `${when(xs[i])}${size > 1 ? ` – ${clock(xs[i] + d.activity.bucket)}` : ''}` : when(xs[i])}</p><p><i class="sw" style="--c:var(--s1c)"></i><b>${pts[i].articles}</b> articles</p><p><i class="sw" style="--c:var(--s2c)"></i><b>${pts[i].posts}</b> X posts</p>` };
    return `<section class="topic-card"><h2>How busy it was<small>per ${size === 1 ? 'hour' : `${size} hours`}</small></h2>
      <ul class="tr-legend"><li style="--c:var(--s1c)"><i class="sw"></i>Articles</li><li style="--c:var(--s2c)"><i class="sw"></i>X posts</li></ul>
      <div class="tr-plot">${svg}</div></section>`;
  }

  function moveSpark(path) {
    if (!path?.length) return '';
    const W = 64, H = 22;
    const t0 = path[0][0], t1 = path[path.length - 1][0];
    const ys = path.map((p) => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pts = path.map(([t, v]) => `${(2 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 4)).toFixed(1)},${(H - 3 - ((v - lo) / Math.max(0.01, hi - lo)) * (H - 6)).toFixed(1)}`).join(' ');
    return `<svg class="cu-mv" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }

  function side(d) {
    const out = [];
    if (d.breaking.length) out.push(`<section class="dy-side"><h2 class="when">Breaking alerts</h2><ul class="dy-list cu-brk">${d.breaking.map((b) => `<li><a href="${esc(b.sid ? `#story/${encodeURIComponent(b.sid)}` : b.url)}">${esc(b.title)}</a><small>${esc(when(b.startedAt))}${b.voices ? ` · ${b.voices} voices in an hour` : ''}</small></li>`).join('')}</ul></section>`);
    if (d.moves.length) {
      out.push(`<section class="dy-side"><h2 class="when">Markets that moved</h2><ul class="dy-list cu-moves">${d.moves.map((m) => {
        const up = m.to > m.from;
        return `<li><div><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a><small>${m.binary ? '' : `${esc(m.label)} · `}${pct(m.from)} → <b class="${up ? 'up' : 'down'}">${pct(m.to)}</b>${m.after ? ` · after <a href="${esc(m.after.sid ? `#story/${encodeURIComponent(m.after.sid)}` : m.after.url)}">${esc(m.after.title.slice(0, 70))}${m.after.title.length > 70 ? '…' : ''}</a>` : ''}</small></div>${moveSpark(m.path)}</li>`;
      }).join('')}</ul></section>`);
    }
    if (d.releases.length) out.push(`<section class="dy-side"><h2 class="when">Released</h2><ul class="dy-list">${d.releases.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a><small>${esc(r.provider || '')}${r.open ? ' · open weights' : ''}</small></li>`).join('')}</ul></section>`);
    if (d.names.length) {
      const max = Math.max(...d.names.map((x) => x.lift));
      out.push(`<section class="dy-side"><h2 class="when">Named far more than usual</h2><ol class="dy-names">${d.names.map((x, i) => `<li style="--i:${i}"><a href="#topic/${esc(x.key)}">${esc(x.label)}</a><b>${x.lift}×</b><span class="dy-bar"><i style="width:${Math.max(4, (x.lift / max) * 100).toFixed(1)}%"></i></span></li>`).join('')}</ol><p class="rail-note">Share of articles naming each, against the four weeks before.</p></section>`);
    }
    if (d.deals.length) out.push(`<section class="dy-side"><h2 class="when">Deals</h2><ul class="dy-list">${d.deals.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.kind === 'acquisition' && x.acquirer ? `${x.acquirer} buys ${x.company}` : x.company)}</a><b>${x.amount ? money(x.amount) : x.valuation ? `${money(x.valuation)} val.` : ''}</b><small>${esc(x.round || x.kind)}${x.outlets > 1 ? ` · ${x.outlets} outlets` : ''}</small></li>`).join('')}</ul></section>`);
    if (d.posts.length) out.push(`<section class="dy-side"><h2 class="when">On X</h2><ul class="dy-posts">${d.posts.map((p) => `<li>${p.avatar ? `<img src="${esc(p.avatar)}" alt="" width="24" height="24" loading="lazy" data-fallback="remove">` : '<i class="dy-av" aria-hidden="true"></i>'}<div><p><a href="#account/${esc(p.handle)}">@${esc(p.handle)}</a> <small>${esc(when(p.at))}</small></p><a class="dy-post" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.text)}</a></div></li>`).join('')}</ul></section>`);
    return out.join('');
  }

  function page(d, animate) {
    const t = d.totals;
    const tiles = [
      [t.stories, 'stories'],
      [t.articles, 'articles'],
      [t.outlets, 'outlets'],
      [t.breaking, t.breaking === 1 ? 'breaking alert' : 'breaking alerts'],
    ];
    const lines = d.storylines.length
      ? `<section><h2 class="when">Stories that moved on</h2><ul class="cu-lines">${d.storylines.map((s, i) => `<li style="--i:${i}"><a class="cu-line" href="#storyline/${esc(s.id)}"><span class="cu-lt">${esc(s.title)}</span><span class="cu-ln">${s.fresh} new ${s.fresh === 1 ? 'chapter' : 'chapters'} · running ${s.dayCount} days</span><span class="cu-latest">Latest: ${esc(s.latest.title)}</span></a></li>`).join('')}</ul></section>`
      : '';
    const s = side(d);
    return `<ul class="ss-tiles dy-tiles">${tiles.map(([b, l], i) => `<li style="--i:${i}"><b>${b.toLocaleString()}</b><span>${l}</span></li>`).join('')}</ul>
      ${activityChart(d, animate)}
      <div class="dy-grid${s ? '' : ' solo'}">
        <div>
          <section><h2 class="when">The biggest stories<span>by outlets · dots show when coverage landed</span></h2><ol class="dy-stories cu-stories${animate ? ' animate' : ''}">${d.stories.map((x, i) => story(x, i, d)).join('')}</ol></section>
          ${lines}
        </div>
        ${s ? `<aside>${s}</aside>` : ''}
      </div>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    const host = $('#catchupView');
    const since = snapped(view.since);
    document.title = `Catch up · ${name}`;
    const chips = [
      away ? `<a class="chip${view.last ? ' on' : ''}" href="#catchup?since=${away}">Since my last visit</a>` : '',
      ...PRESETS.map(([h, l]) => `<a class="chip${view.hours === h ? ' on' : ''}" href="#catchup?h=${h}">${l}</a>`),
    ].join('');
    const head = `<header class="topic-head cu-head">
        <p class="kicker">Catch up</p>
        <h1>${view.last ? 'While you were away' : `The last ${esc(span(Date.now() - since))}`}</h1>
        <p class="topic-sum">Everything since <b>${esc(new Date(since).toLocaleString('en', { weekday: 'long', hour: 'numeric', minute: '2-digit' }))}</b>: what most outlets covered, what broke, what moved and who was suddenly everywhere.</p>
        <nav class="pd-chips" aria-label="How far back">${chips}</nav>
      </header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Catch-up needs the live server.</p>`);
      return;
    }
    load(since);
    const hit = cache.get(since) || {};
    if (!hit.d) {
      chart = null;
      setHtml(host, `${head}${hit.error ? `<p class="rail-note">Catch-up is unavailable: ${esc(hit.error)}</p>` : `<ul class="ss-tiles dy-tiles" aria-busy="true">${'<li><i class="skeleton"></i></li>'.repeat(4)}</ul>${[90, 76, 84, 70, 80].map((w) => `<i class="skeleton" style="width:${w}%;height:18px;margin:12px 0;display:block"></i>`).join('')}`}`);
      return;
    }
    const animate = drawn !== hit.d && !reducedMotion();
    drawn = hit.d;
    setHtml(host, `${head}${page(hit.d, animate)}<div class="ac-tip tr-tip" role="tooltip" hidden></div>`);
  }

  function hover(e) {
    const svg = $('#catchupView svg[data-chart="cuact"]');
    if (!svg || !chart) return;
    const on = e.type !== 'pointerleave' && e.target.closest?.('svg[data-chart="cuact"]');
    const i = on ? pointAt(svg, chart.meta, e.clientX) : -1;
    showPoint(svg, chart.meta, i, $('#catchupView .tr-tip'), $('#catchupView'), i < 0 ? '' : chart.tip(i), setHtml);
  }

  return { route, render, hover, welcome, onWelcomeClick };
}
