// AI status board (#uptime, #uptime/<service>): is it down right now, and how
// often does it go down? A card per service with its state and a 90-day
// strip (one bar per day, coloured by that day's worst incident), when
// incidents tend to start, and every incident with its updates and the news
// and X posts about it. Server side: src/sources/uptime.js (status page
// feeds) and src/index/uptime.js.

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const when = (t) => new Date(t).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dur(min) {
  if (min == null) return '';
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 1440) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${dur(m)} ago`;
};

// Icon + label, never colour alone.
const ICON = {
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.3 5.2-3.8 4.3a.8.8 0 0 1-1.2 0L4.7 8.8a.8.8 0 1 1 1.2-1.1l1 1.1 3.2-3.6a.8.8 0 1 1 1.2 1Z"/></svg>',
  minor: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.9 1.6a1 1 0 0 0-1.8 0l-6.4 11.6A1 1 0 0 0 1.6 15h12.8a1 1 0 0 0 .9-1.5L8.9 1.6ZM8 5c.4 0 .8.4.8.8v3.6a.8.8 0 0 1-1.6 0V5.8c0-.4.4-.8.8-.8Zm0 8.2a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  major: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm2.9 8.8a.8.8 0 1 1-1.1 1.1L8 9.1l-1.8 1.8a.8.8 0 1 1-1.1-1.1L6.9 8 5.1 6.2a.8.8 0 1 1 1.1-1.1L8 6.9l1.8-1.8a.8.8 0 1 1 1.1 1.1L9.1 8l1.8 1.8Z"/></svg>',
  maintenance: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.6 4.3a.5.5 0 0 0-.8-.2l-2 2-1.6-.3-.3-1.6 2-2a.5.5 0 0 0-.2-.8 4 4 0 0 0-5 5.1L1.6 11.6a1.4 1.4 0 0 0 2 2l5.1-5.1a4 4 0 0 0 5.9-4.2Z"/></svg>',
};
const STATE = { ok: 'Operational', minor: 'Degraded', major: 'Major outage', maintenance: 'Maintenance' };
const SEV = { major: 'Major', minor: 'Minor', maintenance: 'Maintenance' };

export function createUptime({ $, esc, setHtml, state, reducedMotion }) {
  const pill = (st, label = STATE[st]) => `<span class="up-pill ${st}"><i class="up-ic">${ICON[st]}</i>${esc(label)}</span>`;
  const view = { svc: null, maint: false };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#uptime(?:\/([\w-]+))?(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.svc = m[1] || null;
    view.maint = new URLSearchParams(m[2] || '').get('maint') === '1';
    return 'uptime';
  }

  async function load(force) {
    // Live state: refresh every two minutes while the page is open.
    if (data.pending || (!force && data.d && Date.now() - data.at < 120e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/uptime');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'uptime') render();
  }
  setInterval(() => { if (state.view === 'uptime' && !document.hidden) load(); }, 60e3);

  const href = (svc, maint = view.maint) => `#uptime${svc ? `/${svc}` : ''}${maint ? '?maint=1' : ''}`;

  // One bar per day; empty days are a short track mark, incident days a full
  // bar in the day's worst severity. Days before the feed's history are hatched.
  function strip(s) {
    const n = s.days.length, P = 5, W = n * P, H = 30;
    const bars = s.days.map((d, i) => {
      const cls = d.d < s.knownSince ? 'nd' : d.sev === 2 ? 'major' : d.sev === 1 ? 'minor' : d.sev === 0 ? 'maintenance' : 'ok';
      const h = cls === 'ok' || cls === 'nd' ? 12 : H;
      return `<rect class="up-day ${cls}" x="${i * P}" y="${H - h}" width="${P - 1.6}" height="${h}" rx="1.2" data-s="${esc(s.key)}" data-i="${i}" style="--i:${i}"/>`;
    }).join('');
    return `<svg class="up-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${s.name}, last ${n} days: ${s.days.filter((d) => d.sev >= 1).length} days with an incident`)}">${bars}</svg>
      <p class="up-axis" aria-hidden="true"><span>${n} days ago</span><span>Today</span></p>`;
  }

  function card(s, i) {
    const sel = view.svc === s.key;
    const line = [
      s.incidents30 ? `${s.incidents30} incident${s.incidents30 === 1 ? '' : 's'} in 30 days` : 'No incidents in 30 days',
      s.medianFixMin != null ? `fixed in ${dur(s.medianFixMin)} (median)` : '',
    ].filter(Boolean).join(' · ');
    return `<li class="up-card ${s.state}${sel ? ' sel' : ''}${view.svc && !sel ? ' dim' : ''}" style="--i:${i}">
      <a href="${esc(href(sel ? null : s.key))}" aria-current="${sel ? 'true' : 'false'}">
        <header><span class="up-name"><img src="${esc(fav(hostOf(s.home)))}" alt="" width="16" height="16" loading="lazy" data-fallback="remove">${esc(s.name)}</span>${pill(s.state)}</header>
        <p class="up-prod">${esc(s.product)}</p>
        ${s.open.length ? `<p class="up-open-line">${s.open.map((o) => `<span>${esc(o.title)} · ${esc(ago(o.started))}</span>`).join('')}</p>` : ''}
        ${strip(s)}
        <p class="up-line">${esc(line)}</p>
      </a>
    </li>`;
  }

  // Incident starts by weekday and UTC hour, across every service.
  function heat(d) {
    const max = Math.max(1, ...d.heat.flat());
    const C = 18, G = 2, L = 34, T = 16;
    const W = L + 24 * (C + G), H = T + 7 * (C + G);
    const lvl = (v) => (v ? Math.min(5, 1 + Math.floor((v / max) * 4.999)) : 0);
    let busiest = { v: 0 };
    d.heat.forEach((row, r) => row.forEach((v, h) => { if (v > busiest.v) busiest = { v, r, h }; }));
    return `<section class="up-heat"><h2 class="when">When incidents start<span>by weekday and hour, UTC, all services</span></h2>
      <div class="up-heat-scroll"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Incident starts by weekday and UTC hour; busiest ${busiest.v ? `${DOW[busiest.r]} ${busiest.h}:00 UTC (${busiest.v})` : 'none'}`)}" style="--w:${W}px">
        ${[0, 6, 12, 18].map((h) => `<text class="lc-xt" x="${L + h * (C + G)}" y="10">${String(h).padStart(2, '0')}:00</text>`).join('')}
        ${d.heat.map((row, r) => `<text class="lc-xt" x="${L - 6}" y="${T + r * (C + G) + C / 2}" dy="0.32em" text-anchor="end">${DOW[r]}</text>${row.map((v, h) => `<rect class="dy-c l${lvl(v)}" x="${L + h * (C + G)}" y="${T + r * (C + G)}" width="${C}" height="${C}" rx="3" data-h="${r}:${h}:${v}"/>`).join('')}`).join('')}
      </svg></div>
      <p class="up-heat-key" aria-hidden="true"><span>Fewer</span>${[0, 1, 2, 3, 4, 5].map((l) => `<i class="dy-c l${l}"></i>`).join('')}<span>More</span></p>
      ${busiest.v ? `<p class="rail-note">Busiest hour: ${DOW[busiest.r]} ${String(busiest.h).padStart(2, '0')}:00 UTC, with ${busiest.v} incident starts. Many incidents are reported during US working hours, when deploys happen and traffic peaks.</p>` : ''}
    </section>`;
  }

  function incident(x, i) {
    const lead = x.news && x.news.leadMin < 0 ? `<span class="up-lead" title="The first report came before the status page's first update">reported ${esc(dur(-x.news.leadMin))} before the status page</span>` : '';
    const state = x.open ? (x.kind === 'maintenance' ? 'maintenance' : x.severity) : null;
    return `<li class="up-inc ${x.severity}${x.open ? ' open' : ''}" style="--i:${Math.min(i, 16)}">
      <details>
        <summary>
          <span class="up-sev ${x.severity}" title="${esc(SEV[x.severity])}"><i class="up-ic">${ICON[x.severity]}</i></span>
          <span class="up-inc-main">
            <span class="up-inc-meta"><b>${esc(x.name)}</b> · ${esc(when(x.started))}${x.open ? '' : x.durMin != null ? ` · ${esc(dur(x.durMin))}` : ''}${x.news ? ` · ${x.news.n} report${x.news.n === 1 ? '' : 's'}` : ''}</span>
            <span class="up-inc-title">${esc(x.title)}</span>
            ${state ? pill(state, x.kind === 'maintenance' ? 'In maintenance' : 'Ongoing') : ''}${lead}
          </span>
        </summary>
        <div class="up-more">
          <ol class="up-updates">${[...x.updates].reverse().map((u) => `<li class="${u.status === 'resolved' ? 'done' : ''}"><p><b>${esc(u.status.replace(/^./, (c) => c.toUpperCase()))}</b> · ${esc(when(u.at))}</p>${u.body ? `<p>${esc(u.body)}</p>` : ''}</li>`).join('')}</ol>
          ${x.components.length ? `<p class="up-comps">${x.components.map((c) => `<span class="tl-chip none">${esc(c)}</span>`).join('')}</p>` : ''}
          ${x.news ? `<h4>In the news and on X</h4><ul class="up-news">${x.news.items.map((n) => `<li><img src="${esc(fav(n.post ? 'x.com' : hostOf(n.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a> <small>${esc(n.source)} · ${esc(when(n.at))}</small></li>`).join('')}</ul>` : ''}
          <p class="up-src"><a href="${esc(x.url)}" target="_blank" rel="noopener">Read it on the status page</a></p>
        </div>
      </details>
    </li>`;
  }

  function page(d) {
    const sel = d.services.find((s) => s.key === view.svc);
    const open = d.incidents.filter((x) => x.open && x.kind === 'incident');
    const list = d.incidents.filter((x) => (!view.svc || x.service === view.svc) && (view.maint || x.kind === 'incident'));
    const noticed = d.stats.noticedFirst;
    const banner = open.length
      ? `<div class="up-now bad" role="status"><i class="up-pulse" aria-hidden="true"></i><div><b>${open.length} incident${open.length === 1 ? '' : 's'} open right now</b><p>${open.slice(0, 4).map((x) => `${esc(x.name)}: ${esc(x.title)}`).join(' · ')}</p></div></div>`
      : `<div class="up-now good" role="status"><i class="up-ic">${ICON.ok}</i><div><b>No open incidents on the services we track</b><p>Checked ${esc(ago(d.generatedAt))}; status pages are read every ten minutes.</p></div></div>`;
    return `${banner}
      <div class="tl-stats up-stats">
        <p><b>${d.stats.incidents7}</b><span>incidents in the last 7 days</span></p>
        <p><b>${d.stats.majors30}</b><span>major outages in 30 days</span></p>
        <p><b>${d.stats.covered}</b><span>incidents in the news or on X${noticed ? `, ${noticed} reported before the status page` : ''}</span></p>
      </div>
      <ul class="up-legend" aria-label="Legend"><li class="ok"><i></i>No incident</li><li class="minor"><i></i>Minor</li><li class="major"><i></i>Major</li><li class="maintenance"><i></i>Maintenance</li><li class="nd"><i></i>Before the feed’s history</li></ul>
      <ol class="up-grid">${d.services.map(card).join('')}</ol>
      <div class="up-cols">
        <section class="up-list-wrap">
          <h2 class="when">${sel ? `${esc(sel.name)} incidents` : 'Incidents'}<span>${list.length}, last ${d.days} days</span>${sel ? `<a class="tl-clear" href="${esc(href(null))}">All services</a>` : ''}</h2>
          <p class="up-toggle"><a href="${esc(href(view.svc, !view.maint))}" role="switch" aria-checked="${view.maint}"><i></i>Show scheduled maintenance</a></p>
          <ol class="up-incs">${list.slice(0, 120).map(incident).join('') || '<li class="rail-note">No incidents in this period.</li>'}</ol>
        </section>
        ${heat(d)}
      </div>
      <p class="rail-note">From the public incident feeds on each company’s status page, read every ten minutes. Major or minor is judged from the incident’s wording (“outage”, “unavailable” vs “degraded”, “elevated errors”). Durations run from the first update to “resolved”. Reports are headlines and X posts naming the service and an outage, from three hours before an incident until twelve hours after it. <a href="/api/uptime">JSON</a></p>
      <div class="ac-tip up-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#uptimeView');
    document.title = `AI status · ${site}`;
    const head = `<header class="topic-head up-head"><p class="kicker">AI status</p><h1>Is it down?</h1>
      <p class="topic-sum">Live status and 90 days of incidents for ChatGPT, Claude, Copilot, Cursor, Perplexity, DeepSeek, Hugging Face and more, with what the press and X said while they were down.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The status board needs the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:420px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const sel = d.services.find((s) => s.key === view.svc);
    if (sel) document.title = `${sel.name} status · ${site}`;
    // Animate the first draw only, not the two-minute refreshes or filters.
    const animate = !drawn && !reducedMotion();
    drawn = d.generatedAt;
    setHtml(host, `${head}<div class="up-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  // Day bars and heat cells: what happened that day / hour.
  function hover(e) {
    const tip = $('#uptimeView .up-tip');
    if (!tip || !data.d) return;
    const t = e.target;
    let html = '';
    if (e.type !== 'pointerleave' && t.classList?.contains('up-day')) {
      const s = data.d.services.find((x) => x.key === t.dataset.s);
      const day = s?.days[+t.dataset.i];
      if (day) html = `<p class="tt-h">${esc(s.name)} · ${esc(dayLabel(day.d))}</p>${day.d < s.knownSince ? '<p>Before the feed’s history</p>' : day.n ? day.titles.map((x) => `<p>${esc(x)}</p>`).join('') + (day.n > day.titles.length ? `<p>and ${day.n - day.titles.length} more</p>` : '') : '<p>No incident</p>'}`;
    } else if (e.type !== 'pointerleave' && t.dataset?.h) {
      const [r, h, v] = t.dataset.h.split(':').map(Number);
      html = `<p class="tt-h">${DOW[r]} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 UTC</p><p>${v} incident start${v === 1 ? '' : 's'}</p>`;
    }
    if (!html) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#uptimeView').getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const w = tip.offsetWidth || 220;
    const left = r.left - host.left + r.width / 2 - w / 2;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, left))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
