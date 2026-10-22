// Breaking news: the banner over every page, the #breaking archive with
// each story's coverage curve, and opt-in push alerts.
// Server side: src/pipeline/breaking.js (detection), src/pipeline/alerts.js.

import { feedBtn } from './developers.js';

const MIN = 60e3;
const STEP = 10 * MIN;

export function createBreaking({ $, esc, ago, time, setHtml, store, state, reducedMotion }) {
  const page = { days: 7, data: null, at: 0, pending: false, error: null };
  const alerts = { status: 'unknown', busy: false, error: null };
  let shown = null; // archive data already animated

  const dismissed = new Set(store.get('fw.bdismiss', []));
  const active = () => (state.data?.breaking || []).filter((b) => b.sid);
  const storyHref = (b) => `#story/${encodeURIComponent(b.sid)}`;
  const span = (ms) => {
    const m = Math.max(0, Math.round(ms / MIN));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  };

  // ---- Banner ----
  function renderBanner() {
    const bar = $('#breakingBar');
    const bell = $('#bell');
    const live = active();
    bell?.classList.toggle('hot', live.length > 0);
    bell?.setAttribute('aria-label', live.length ? `Breaking now: ${live.length} ${live.length === 1 ? 'story' : 'stories'}. Breaking news and alerts` : 'Breaking news and alerts');
    const top = live.find((b) => !dismissed.has(b.sid));
    const hide = !top || state.view === 'breaking' || (state.view === 'story' && state.storyId === top.sid);
    if (hide) {
      bar.hidden = true;
      return;
    }
    const more = live.length - 1;
    const pace = top.now?.voices || top.voices;
    setHtml(bar, `<div class="bk-inner" data-id="${esc(top.sid)}">
      <span class="bk-label"><i aria-hidden="true"></i>Breaking</span>
      <a class="bk-title" href="${storyHref(top)}">${esc(top.title)}</a>
      <span class="bk-meta">${pace} ${pace === 1 ? 'source' : 'sources'} in the last hour · broke ${time(top.startedAt)}${more > 0 ? ` · <a href="#breaking">+${more} more</a>` : ''}</span>
      <button class="bk-close" type="button" data-bdismiss="${esc(top.sid)}" aria-label="Dismiss">×</button>
    </div>`);
    if (bar.hidden) {
      bar.hidden = false;
      if (!reducedMotion()) {
        bar.classList.remove('enter');
        void bar.offsetWidth;
        bar.classList.add('enter');
      }
    }
  }

  function dismiss(sid) {
    dismissed.add(sid);
    store.set('fw.bdismiss', [...dismissed].slice(-50));
    renderBanner();
  }

  // ---- Coverage curves ----
  // Distinct sources so far from the first report, one point per 10 minutes.
  function curveGeom(b, w, h, pad) {
    const c = b.curve?.length ? b.curve : [0, b.voices || 0];
    const max = Math.max(4, ...c);
    const x = (i) => pad.l + (i / Math.max(1, c.length - 1)) * (w - pad.l - pad.r);
    const y = (v) => h - pad.b - (v / max) * (h - pad.t - pad.b);
    const pts = c.map((v, i) => [x(i), y(v)]);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    const brokeI = Math.min(c.length - 1, Math.max(0, Math.round((b.startedAt - b.firstAt) / STEP)));
    return { c, max, x, y, pts, line, brokeI };
  }

  function sparkHtml(b) {
    const w = 120, h = 34;
    const g = curveGeom(b, w, h, { l: 2, r: 4, t: 4, b: 3 });
    const [bx, by] = g.pts[g.brokeI];
    return `<svg class="bk-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      <path class="area" d="${g.line}L${g.pts.at(-1)[0].toFixed(1)},${h - 3}L${g.pts[0][0].toFixed(1)},${h - 3}Z"/>
      <path class="ln" d="${g.line}" pathLength="1"/><circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="3"/></svg>`;
  }

  function chartHtml(b, animate) {
    // Narrow screens get a smaller drawing so the labels stay readable.
    const [w, h] = innerWidth < 640 ? [360, 170] : [640, 190];
    const pad = { l: 34, r: 12, t: 14, b: 26 };
    const g = curveGeom(b, w, h, pad);
    const [bx] = g.pts[g.brokeI];
    const ticks = [0, Math.round(g.max / 2), g.max];
    const mins = (g.c.length - 1) * 10;
    const xt = [0, Math.round(mins / 2 / 10) * 10, mins];
    return `<figure class="bk-chart${animate ? ' animate' : ''}" data-curve="${esc(b.sid)}" data-w="${w}" data-h="${h}">
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`Sources covering it: ${g.c.at(-1)} after ${span(mins * MIN)}; it broke ${span(b.startedAt - b.firstAt)} after the first report.`)}">
        ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${g.y(t).toFixed(1)}" y2="${g.y(t).toFixed(1)}"/><text class="ax" x="${pad.l - 8}" y="${(g.y(t) + 4).toFixed(1)}" text-anchor="end">${t}</text>`).join('')}
        ${xt.map((m, i) => `<text class="ax" x="${g.x(m / 10).toFixed(1)}" y="${h - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${m === 0 ? 'First report' : `+${span(m * MIN)}`}</text>`).join('')}
        <path class="area" d="${g.line}L${g.pts.at(-1)[0].toFixed(1)},${h - pad.b}L${g.pts[0][0].toFixed(1)},${h - pad.b}Z"/>
        <line class="broke" x1="${bx.toFixed(1)}" x2="${bx.toFixed(1)}" y1="${pad.t}" y2="${h - pad.b}"/>
        <text class="broke-t" x="${(bx + 6).toFixed(1)}" y="${pad.t + 10}">Broke</text>
        <path class="ln" d="${g.line}" pathLength="1"/>
        <g class="hov" hidden><line y1="${pad.t}" y2="${h - pad.b}"/><circle r="4"/></g>
      </svg>
      <figcaption class="bk-tip" hidden></figcaption>
    </figure>`;
  }

  // Crosshair on the big curves.
  function hover(e) {
    const fig = e.target.closest?.('.bk-chart');
    for (const f of document.querySelectorAll('.bk-chart.hovering')) if (f !== fig) { f.classList.remove('hovering'); f.querySelector('.hov').hidden = true; f.querySelector('.bk-tip').hidden = true; }
    if (!fig || e.type === 'pointerleave') return;
    const b = [...active(), ...(page.data?.history || [])].find((x) => x.sid === fig.dataset.curve);
    if (!b) return;
    const svg = fig.querySelector('svg');
    const r = svg.getBoundingClientRect();
    const w = Number(fig.dataset.w), h = Number(fig.dataset.h);
    const g = curveGeom(b, w, h, { l: 34, r: 12, t: 14, b: 26 });
    const px = ((e.clientX - r.left) / r.width) * w;
    let i = 0;
    for (let k = 0; k < g.pts.length; k++) if (Math.abs(g.pts[k][0] - px) < Math.abs(g.pts[i][0] - px)) i = k;
    const [x, y] = g.pts[i];
    const hov = fig.querySelector('.hov');
    hov.hidden = false;
    hov.querySelector('line').setAttribute('x1', x);
    hov.querySelector('line').setAttribute('x2', x);
    hov.querySelector('circle').setAttribute('cx', x);
    hov.querySelector('circle').setAttribute('cy', y);
    const tip = fig.querySelector('.bk-tip');
    tip.hidden = false;
    const strong = document.createElement('b');
    strong.textContent = `${g.c[i]} ${g.c[i] === 1 ? 'source' : 'sources'}`;
    tip.replaceChildren(strong, i ? `${span(i * STEP)} after the first report` : 'First report');
    const left = (x / w) * r.width;
    tip.style.transform = `translate(${Math.round(Math.min(r.width - 170, Math.max(0, left - 85)))}px, 0)`;
    fig.classList.add('hovering');
  }

  // ---- Alerts ----
  const pushable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function alertState() {
    if (!pushable()) return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    if (Notification.permission === 'denied') return 'denied';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
    } catch {
      return 'off';
    }
  }

  async function refreshAlerts() {
    const s = await alertState();
    if (s !== alerts.status) {
      alerts.status = s;
      if (state.view === 'breaking') renderPage();
    }
  }

  async function toggleAlerts() {
    if (alerts.busy) return;
    alerts.busy = true;
    alerts.error = null;
    renderPage();
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch('api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: existing.endpoint }) }).catch(() => {});
        await existing.unsubscribe();
      } else {
        if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.');
        const { publicKey } = await (await fetch('api/push/key')).json();
        const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const res = await fetch('api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
        if (!res.ok) {
          await sub.unsubscribe();
          throw new Error((await res.json().catch(() => ({}))).error || 'The server did not accept the subscription.');
        }
      }
    } catch (err) {
      alerts.error = err.message;
    }
    alerts.busy = false;
    alerts.status = await alertState();
    renderPage();
  }

  function alertCard() {
    const s = alerts.status;
    const msg = {
      unsupported: 'This browser can’t receive push notifications.',
      insecure: 'Alerts need the site opened over HTTPS (or at localhost on the server itself). Browsers only allow push on secure pages.',
      denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.',
      on: 'You’ll get a notification when a story breaks: at most one every 20 minutes, a few a day.',
      off: 'Get a notification when a story breaks, even with this tab closed. About three to four a day.',
      unknown: 'Checking…',
    }[s];
    const btn = s === 'on' || s === 'off'
      ? `<button class="bk-alert-btn${s === 'on' ? ' on' : ''}" type="button" data-alerts ${alerts.busy ? 'disabled' : ''}>${alerts.busy ? 'Working…' : s === 'on' ? 'Turn off alerts' : 'Turn on alerts'}</button>`
      : '';
    return `<section class="bk-alerts" aria-live="polite">
      <h2><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a5 5 0 0 0-5 5v3.2L3.5 13.5h13L15 10.7V7.5a5 5 0 0 0-5-5ZM8 15.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>Breaking alerts${s === 'on' ? ' <span class="bk-on">On</span>' : ''}</h2>
      <p>${msg}</p>${btn}${alerts.error ? `<p class="bk-err">${esc(alerts.error)}</p>` : ''}
      <p class="bk-fine">Nothing about you is stored: only your browser’s anonymous push address.</p>
    </section>`;
  }

  // ---- Archive page ----
  async function load() {
    if (state.mode !== 'api' || page.pending || (page.data && Date.now() - page.at < 60e3 && page.data.version === state.data?.version)) return;
    page.pending = true;
    try {
      const res = await fetch(`api/breaking?days=${page.days}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.statusText);
      page.data = d;
      page.error = null;
    } catch (err) {
      page.error = err.message;
    }
    page.at = Date.now();
    page.pending = false;
    if (state.view === 'breaking') renderPage();
  }

  function rowHtml(b, i) {
    const lead = b.startedAt - b.firstAt;
    const dur = (b.endedAt || Date.now()) - b.startedAt;
    return `<li style="--i:${Math.min(i, 12)}" data-id="${esc(b.sid)}">
      ${sparkHtml(b)}
      <div><a href="${storyHref(b)}">${esc(b.title)}</a>
      <span class="tl-meta">${time(b.startedAt)} · broke ${span(lead)} after the first report · ${b.voices} sources at its peak hour${b.endedAt ? ` · lasted ${span(dur)}` : ' · <b class="bk-now">breaking now</b>'}</span></div>
    </li>`;
  }

  function renderPage() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `Breaking · ${name}`;
    load();
    if (alerts.status === 'unknown') refreshAlerts();
    const d = page.data;
    const animate = !!d && shown !== d && !reducedMotion();
    if (d) shown = d;
    const live = d?.active?.length ? d.active : active();
    const now = live.length ? live.map((b) => `<article class="bk-card" data-id="${esc(b.sid)}">
        <p class="kicker"><span class="bk-label"><i aria-hidden="true"></i>Breaking now</span></p>
        <h2><a href="${storyHref(b)}">${esc(b.title)}</a></h2>
        <p class="bk-sum">${b.now?.voices ?? b.voices} sources in the last hour · first reported ${time(b.firstAt)}, broke ${span(b.startedAt - b.firstAt)} later</p>
        ${b.curve ? chartHtml(b, animate) : ''}
      </article>`).join('') : `<p class="bk-quiet">Nothing is breaking right now. A story breaks when four or more separate outlets, labs or X accounts pick it up within an hour.</p>`;
    const past = (d?.history || []).filter((b) => b.endedAt);
    const hist = d
      ? past.length ? `<ol class="bk-list${animate ? ' animate' : ''}">${past.map(rowHtml).join('')}</ol>` : '<p class="rail-note">No stories broke in this window.</p>'
      : page.error ? `<p class="rail-note">The archive is unavailable: ${esc(page.error)}</p>` : state.mode === 'api' ? '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>' : '<p class="rail-note">The archive needs the live server.</p>';
    const perDay = d ? (d.history.length / page.days).toFixed(1).replace(/\.0$/, '') : null;
    setHtml($('#breakingView'), `
      <header class="topic-head">
        <a class="back" href="#news">← News</a>
        <div class="head-row"><p class="kicker">Breaking</p>${feedBtn('/feeds/breaking.xml')}</div>
        <h1>When everyone picks it up at once</h1>
        <p class="topic-sum">Stories that many separate outlets, labs and X accounts covered within the same hour.${perDay ? ` ${perDay} a day over the last ${page.days === 1 ? 'day' : `${page.days} days`}.` : ''}</p>
      </header>
      <div class="topic-grid">
        <div class="bk-main">
          ${now}
          <section class="topic-timeline">
            <div class="bk-hist-head"><h2>Earlier breaks</h2>
              <div class="chips chips-quiet" role="group" aria-label="Window">${[1, 7, 30].map((n) => `<button class="chip" type="button" data-bdays="${n}" aria-pressed="${page.days === n}">${n === 1 ? '24 hours' : `${n} days`}</button>`).join('')}</div>
            </div>
            ${hist}
          </section>
        </div>
        <aside class="topic-side">
          ${alertCard()}
          <section><h2>How it works</h2>
            <p class="bk-how">Every few minutes each story’s last hour is counted in distinct voices: an outlet counts 1, a lab’s own post 1.5, an X account ¾ (up to four), Hacker News or a subreddit 0.4. Outlets running the same wire copy count once. At 4, with at least two outlets or labs, and a first report under six hours old, the story breaks. It ends when the pace drops under 2 for half an hour.</p>
          </section>
        </aside>
      </div>`);
  }

  function onClick(t) {
    const d = t.dataset;
    if (d.bdismiss) { dismiss(d.bdismiss); return true; }
    if (d.bdays) { page.days = Number(d.bdays); page.data = null; renderPage(); return true; }
    if (d.alerts != null) { toggleAlerts(); return true; }
    return false;
  }

  return { renderBanner, renderPage, onClick, hover };
}
