// What's coming (#ahead?k=<kind>&d=<YYYY-MM-DD>): dates in AI news. Three
// month grids with a dot per item (tap a day to see it), dates known only to
// the month or quarter above each grid, and an agenda by week and month with
// "add to calendar" on each day-precise date and a feed to subscribe to.
// Server side: src/index/ahead.js.

const KINDS = ['launch', 'event', 'deadline', 'retire', 'market'];
const color = (k) => (k === 'market' ? 'var(--ah-grey)' : `var(--s${KINDS.indexOf(k) + 1}c)`);
const DAY = 86400e3;
const parse = (d) => Date.parse(`${d}T00:00:00Z`);
const fmt = (d, o) => new Date(parse(d)).toLocaleDateString('en', { timeZone: 'UTC', ...o });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function createAhead({ $, esc, setHtml, state, reducedMotion }) {
  const view = { k: '', d: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let opened = '';

  function route(hash) {
    const m = /^#ahead(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.k = KINDS.includes(p.get('k')) ? p.get('k') : '';
    view.d = /^\d{4}-\d\d-\d\d$/.test(p.get('d') || '') ? p.get('d') : '';
    return 'ahead';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 15 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/ahead');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'ahead') render();
  }

  const href = (over = {}) => {
    const v = { ...view, ...over };
    const p = new URLSearchParams();
    for (const k of ['k', 'd']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#ahead${s ? `?${s}` : ''}`;
  };
  const shown = (d) => d.items.filter((x) => !view.k || x.kind === view.k);

  // One month as a grid, weeks starting Monday.
  function month(d, y, m, items) {
    const first = Date.UTC(y, m, 1);
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const lead = (new Date(first).getUTCDay() + 6) % 7;
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    const byDay = new Map();
    for (const x of items) if (x.precision === 'day' && x.date.startsWith(key)) byDay.set(x.date, [...(byDay.get(x.date) || []), x]);
    const loose = items.filter((x) => (x.precision === 'month' && x.date.startsWith(key)) || (x.precision === 'quarter' && x.date.startsWith(key)) || (x.precision === 'week' && x.date.startsWith(key)));
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<li class="ah-pad" aria-hidden="true"></li>');
    for (let day = 1; day <= days; day++) {
      const date = `${key}-${String(day).padStart(2, '0')}`;
      const list = byDay.get(date) || [];
      const past = date < d.today;
      const cls = `${past ? ' past' : ''}${date === d.today ? ' today' : ''}${view.d === date ? ' on' : ''}${list.length ? ' has' : ''}`;
      const dots = list.slice(0, 4).map((x) => `<i style="background:${color(x.kind)}"></i>`).join('');
      cells.push(list.length
        ? `<li class="ah-day${cls}"><a href="${esc(href({ d: view.d === date ? '' : date }))}" data-day="${date}" aria-label="${esc(`${fmt(date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${list.map((x) => x.title).join('; ')}`)}"><b>${day}</b><span class="ah-dots">${dots}</span></a></li>`
        : `<li class="ah-day${cls}"><span><b>${day}</b></span></li>`);
    }
    return `<section class="ah-month"><h3>${esc(fmt(`${key}-01`, { month: 'long', year: 'numeric' }))}</h3>
      ${loose.length ? `<p class="ah-loose">${loose.map((x) => `<span title="${esc(x.title)}"><i style="background:${color(x.kind)}"></i>${esc(x.precision === 'quarter' ? 'Q' + (Math.floor(Number(x.date.slice(5, 7)) / 3) + 1) : x.precision === 'week' ? 'Week' : 'Sometime')}: ${esc(x.title.length > 48 ? `${x.title.slice(0, 46)}…` : x.title)}</span>`).join('')}</p>` : ''}
      <ol class="ah-grid"><li class="ah-dow">M</li><li class="ah-dow">T</li><li class="ah-dow">W</li><li class="ah-dow">T</li><li class="ah-dow">F</li><li class="ah-dow">S</li><li class="ah-dow">S</li>${cells.join('')}</ol></section>`;
  }

  function heading(x, today) {
    const t = parse(x.date), now = parse(today);
    const dow = (new Date(now).getUTCDay() + 6) % 7;
    const weekEnd = now + (7 - dow) * DAY;
    if (x.precision === 'quarter') return `Q${Math.floor(Number(x.date.slice(5, 7)) / 3) + 1} ${x.date.slice(0, 4)}`;
    if (x.precision === 'month') return `Sometime in ${fmt(x.date, { month: 'long', year: x.date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' })}`;
    if (t < weekEnd) return 'This week';
    if (t < weekEnd + 7 * DAY) return 'Next week';
    return fmt(x.date, { month: 'long', year: x.date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' });
  }

  function item(x, d, i) {
    const badge = x.precision === 'day' ? `<span class="ah-date"><small>${esc(fmt(x.date, { weekday: 'short' }))}</small><b>${esc(fmt(x.date, { day: 'numeric' }))}</b><small>${esc(fmt(x.date, { month: 'short' }))}</small></span>`
      : `<span class="ah-date loose"><small>${esc(x.precision === 'week' ? 'week of' : x.precision === 'quarter' ? 'quarter' : 'month')}</small><b>${esc(x.precision === 'quarter' ? `Q${Math.floor(Number(x.date.slice(5, 7)) / 3) + 1}` : x.precision === 'week' ? fmt(x.date, { day: 'numeric' }) : fmt(x.date, { month: 'short' }))}</b><small>${esc(x.precision === 'week' ? fmt(x.date, { month: 'short' }) : x.date.slice(0, 4))}</small></span>`;
    const markets = x.kind === 'market' ? `<ol class="ah-mk">${x.markets.slice(0, 4).map((m) => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>${m.lead ? `<span class="ah-odds"><i style="width:${Math.round(m.lead.yes * 100)}%"></i></span><small>${esc(m.lead.label)} ${Math.round(m.lead.yes * 100)}%</small>` : ''}</li>`).join('')}${x.marketCount > 4 ? `<li class="ah-more">and ${x.marketCount - 4} more</li>` : ''}</ol>` : '';
    return `<li class="ah-item${view.d === x.date ? ' on' : ''}" id="ah-${esc(x.id)}" style="--i:${Math.min(i, 16)}">
      ${badge}
      <div class="ah-body">
        <p class="ah-kind"><i style="background:${color(x.kind)}"></i>${esc(d.kinds.find((k) => k.key === x.kind)?.label || x.kind)}</p>
        ${x.kind === 'market' ? `<h3>${esc(x.title)}</h3>${markets}` : `<h3><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></h3>
        <p class="ah-src">${esc(x.source)}${x.outlets > 1 ? ` and ${x.outlets - 1} more` : ''}${x.reports.length > 1 ? ` · ${x.reports.slice(1, 3).map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source)}</a>`).join(', ')}` : ''}</p>`}
        ${x.precision === 'day' ? `<p class="ah-acts"><a class="ah-add" href="/api/ahead.ics?id=${encodeURIComponent(x.id)}" download>Add to calendar</a></p>` : ''}
      </div></li>`;
  }

  function page(d) {
    const s = d.stats;
    const today = parse(d.today);
    const t = new Date(today);
    const months = [0, 1, 2].map((k) => [t.getUTCFullYear() + Math.floor((t.getUTCMonth() + k) / 12), (t.getUTCMonth() + k) % 12]);
    const list = shown(d);
    const agenda = (view.d ? list.filter((x) => x.date === view.d) : list);
    let last = '';
    const rows = [];
    agenda.forEach((x, i) => {
      const h = view.d ? fmt(view.d, { weekday: 'long', month: 'long', day: 'numeric' }) : heading(x, d.today);
      if (h !== last) { rows.push(`<li class="ah-h"><h2 class="when">${esc(h)}</h2></li>`); last = h; }
      rows.push(item(x, d, i));
    });
    const origin = location.host;
    return `<div class="tl-stats">
        <p><b>${s.next30}</b><span>dates in the next 30 days from the news, ${s.items} in all</span></p>
        <p><b>${s.retire}</b><span>${s.retire === 1 ? 'model or product retirement' : 'model and product retirements'} ahead</span></p>
        <p><b>${s.markets30}</b><span>prediction markets close in the next 30 days</span></p>
        <p class="ah-sub"><a class="ah-btn" href="webcal://${esc(origin)}/api/ahead.ics">Subscribe in your calendar</a><a class="ah-btn ghost" href="/api/ahead.ics" download>Download .ics</a></p>
      </div>
      <nav class="pd-chips ct-themes" aria-label="Kind"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '' }))}">All</a>${d.kinds.filter((k) => k.n).map((k) => `<a class="chip${view.k === k.key ? ' on' : ''}" href="${esc(href({ k: view.k === k.key ? '' : k.key }))}"><i class="ah-sw" style="background:${color(k.key)}"></i>${esc(k.label)} <small>${k.n}</small></a>`).join('')}</nav>
      <div class="ah-months">${months.map(([y, m]) => month(d, y, m, list)).join('')}</div>
      <section class="ah-agenda">${view.d ? `<p class="ah-clear"><a class="tl-clear" href="${esc(href({ d: '' }))}">Show every date</a></p>` : ''}<ol>${rows.join('') || '<li class="rail-note">Nothing on this date.</li>'}</ol></section>
      <p class="rail-note">From ${d.scanned} headlines in the last ${d.lookback} days that name a date: “on January 14”, “starting next month”, “in Q1 2027”, “next week”. A date is read from the day the headline ran, a bare month or weekday needs a word that looks ahead (will, set to, expected), and headlines looking back are left out. Market closing days are in New York time. Dates move; check the source before planning around one. Longer-range forecasts are on <a href="#predictions">Predictions</a>. <a href="/api/ahead">JSON</a></p>
      <div class="ac-tip ah-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#aheadView');
    document.title = `What’s coming · ${site}`;
    const head = `<header class="topic-head ah-head"><p class="kicker">Calendar</p><h1>What’s coming</h1>
      <p class="topic-sum">Launches, events, deadlines and model retirements the news has put a date on, and the prediction markets about to close.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The calendar needs the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:320px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== d.generatedAt && !reducedMotion();
    drawn = d.generatedAt;
    setHtml(host, `${head}<div class="ah-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.d && opened !== view.d) {
      // After the router's scroll to the top.
      requestAnimationFrame(() => $('#aheadView .ah-agenda')?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
    opened = view.d;
  }

  function hover(e) {
    const tip = $('#aheadView .ah-tip');
    const d = data.d;
    if (!tip || !d) return;
    const a = e.type === 'pointerleave' ? null : e.target?.closest?.('[data-day]');
    const list = a ? shown(d).filter((x) => x.date === a.dataset.day && x.precision === 'day') : [];
    if (!list.length) { tip.hidden = true; return; }
    setHtml(tip, `<p class="tt-h">${esc(fmt(a.dataset.day, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>${list.slice(0, 5).map((x) => `<p><i class="sw" style="--c:${color(x.kind)}"></i>${esc(x.title.length > 70 ? `${x.title.slice(0, 68)}…` : x.title)}</p>`).join('')}${list.length > 5 ? `<p><small>and ${list.length - 5} more</small></p>` : ''}`);
    tip.hidden = false;
    const host = $('#aheadView').getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const w = tip.offsetWidth || 220;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
