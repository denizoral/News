// Robots (#robots?k=<kind>&c=<company>&r=<region>&f=<form>&e=<id>): a year of
// robotics. Monthly events stacked by what happened, the race between the
// US, China, Europe and Japan and Korea as small multiples on one scale,
// companies that filter, the biggest rounds, price tags on a log scale,
// production targets, and event cards with every report. Server side:
// src/index/robots.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const monLong = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const usd = (v) => (v >= 1e9 ? `$${+(v / 1e9).toPrecision(3)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${Math.round(v / 1e3)}K`);
const price = (v) => `$${v.toLocaleString('en')}`;
const units = (v) => (v >= 1e6 ? `${+(v / 1e6).toPrecision(3)} million` : v.toLocaleString('en'));
const DAY = 86400e3;
// Four series and setbacks in grey: production goes with putting robots to work.
const SERIES = [['funding', 'Money raised'], ['launch', 'Unveiled'], ['deploy', 'Put to work or built'], ['brain', 'Robot brains and data'], ['setback', 'Setbacks']];
const slotOf = (k) => (k === 'production' ? 2 : SERIES.findIndex(([s]) => s === k));
const REGION_SHORT = { us: 'US', china: 'China', europe: 'Europe', asia: 'JP · KR' };

export function createRobots({ $, esc, setHtml, state, reducedMotion }) {
  const view = { k: '', c: '', r: '', f: '', e: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let scrolled = '';

  function route(hash) {
    const m = /^#robots(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    for (const k of ['k', 'c', 'r', 'f']) view[k] = (p.get(k) || '').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    view.e = (p.get('e') || '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
    return 'robots';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/robots');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'robots') render();
  }

  const href = (over = {}) => {
    const v = { ...view, e: '', ...over };
    const p = new URLSearchParams();
    for (const k of ['k', 'c', 'r', 'f', 'e']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#robots${s ? `?${s}` : ''}`;
  };

  const kindOk = (x) => !view.k || x.kind === view.k || (view.k === 'deploy' && x.kind === 'production');
  const matches = (x) => kindOk(x) && (!view.c || x.company?.key === view.c) && (!view.r || x.company?.region === view.r) && (!view.f || x.form === view.f);

  function columns(d, narrow) {
    const W = narrow ? 360 : 640, H = 210, L = 28, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.n));
    const step = max > 40 ? 20 : max > 16 ? 10 : max > 8 ? 4 : 2;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      const vals = SERIES.map(() => 0);
      for (const [k, n] of Object.entries(m.kinds)) vals[slotOf(k)] += n;
      let acc = 0;
      const segs = vals.map((v, s) => {
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="rb-seg s${s + 1}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="rb-col" style="--i:${i}" data-m="${i}">${segs}<rect class="rb-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section class="rb-cols"><h2 class="when">What happened<span>events by month</span></h2>
      <ul class="tr-legend">${SERIES.map(([k, l], s) => `<li style="--c:${k === 'setback' ? 'var(--rb-grey)' : `var(--s${s + 1}c)`}"><i class="sw"></i>${esc(l)}</li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${monLong(m.m)}: ${plural(m.n, 'event')}`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // One small chart per region on a shared scale, so the heights compare.
  function race(d, narrow) {
    const max = Math.max(2, ...d.months.flatMap((m) => Object.values(m.regions)));
    const W = narrow ? 170 : 220, H = 86, T = 6, B = 16;
    const bw = W / d.months.length;
    const panels = d.regions.map((r, ri) => {
      const on = view.r === r.key;
      const bars = d.months.map((m, i) => {
        const v = m.regions[r.key];
        const h = (v / max) * (H - T - B);
        return `<g class="rb-rc" data-r="${r.key}" data-m="${i}" style="--i:${i}">${v ? `<rect class="rb-rbar" x="${(i * bw + bw * 0.16).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5"/>` : ''}<rect class="rb-hit" x="${(i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>`;
      }).join('');
      const ch = r.prev90 ? Math.round(((r.n90 - r.prev90) / r.prev90) * 100) : null;
      return `<a class="rb-panel${on ? ' on' : ''}${view.r && !on ? ' dim' : ''}" href="${esc(href({ r: on ? '' : r.key }))}" style="--i:${ri}">
        <p class="rb-ph"><b>${esc(narrow ? REGION_SHORT[r.key] : r.label)}</b><span>${r.n90} in 90 days${ch != null ? ` · ${ch >= 0 ? '+' : '−'}${Math.abs(ch)}%` : ''}</span></p>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${r.label}: ${d.months.map((m) => `${monLong(m.m)} ${m.regions[r.key]}`).join(', ')}`)}">
          <line class="rb-base" x1="0" x2="${W}" y1="${H - B}" y2="${H - B}"/>${bars}
          <text class="lc-xt" x="0" y="${H - 3}">${esc(monFmt(d.months[0].m))}</text><text class="lc-xt" x="${W}" y="${H - 3}" text-anchor="end">${esc(monFmt(d.months.at(-1).m))}</text>
        </svg></a>`;
    }).join('');
    return `<section class="rb-race"><h2 class="when">The race<span>events naming a company from each region, by month, on one scale; tap to filter</span></h2><div class="rb-panels">${panels}</div></section>`;
  }

  function companies(d) {
    const rows = d.companies.slice(0, 14);
    const max = Math.max(1, ...rows.map((c) => c.n));
    return `<section class="rb-cos"><h2 class="when">Companies<span>events in a year; tap to filter</span></h2><ol>${rows.map((c, i) => {
      const on = view.c === c.key;
      return `<li style="--i:${i}"><a href="${esc(href({ c: on ? '' : c.key }))}" class="${on ? 'on' : ''}${view.c && !on ? ' dim' : ''}" data-c="${esc(c.key)}">
        <span class="rb-co">${esc(c.label)}</span><span class="rb-reg">${esc(REGION_SHORT[c.region] || '')}</span><span class="rb-bar" style="width:${((100 * c.n) / max).toFixed(1)}%"></span><small>${c.n}</small></a></li>`;
    }).join('')}</ol></section>`;
  }

  function roundsList(d) {
    const rows = d.rounds.slice(0, 10);
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r.usd));
    return `<section class="rb-rounds"><h2 class="when">Biggest rounds<span>money raised or paid in a year</span></h2><ol>${rows.map((r, i) => `<li style="--i:${i}"><a href="${esc(href({ e: r.id, c: r.company?.region ? r.company.key : '' }))}" data-e="${esc(r.id)}">
      <span class="rb-co">${esc(r.company?.label || 'A startup')}</span><span class="rb-bar" style="width:${Math.max(1.5, (100 * r.usd) / max).toFixed(1)}%"></span><small>${esc(usd(r.usd))}</small></a></li>`).join('')}</ol></section>`;
  }

  // Price tags on a log scale: a $299 toy and a $20,000 home robot on one line.
  function prices(d, narrow) {
    const list = d.prices;
    if (!list.length) return '';
    const W = narrow ? 360 : 640, L = 14, R = 14, H = 64 + Math.min(list.length, 8) * 0;
    const lo = Math.log10(100), hi = Math.log10(Math.max(100000, ...list.map((p) => p.price)));
    const x = (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (W - L - R);
    const ticks = [100, 1000, 10000, 100000].filter((v) => Math.log10(v) <= hi);
    const dots = list.map((p, i) => {
      const up = i % 2 === 0;
      const cx = x(p.price);
      const anchor = cx < 60 ? 'start' : cx > W - 60 ? 'end' : 'middle';
      return `<g class="rb-pt" data-p="${i}" style="--i:${i}"><circle cx="${cx.toFixed(1)}" cy="34" r="6"/>
        <text x="${cx.toFixed(1)}" y="${up ? 18 : 56}" text-anchor="${anchor}">${esc(`${price(p.price)}${p.company ? ` ${p.company.label}` : ''}`)}</text></g>`;
    }).join('');
    return `<section class="rb-prices"><h2 class="when">Price tags<span>what a robot costs when the price is named, log scale</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(list.map((p) => `${p.company?.label || 'A robot'}: ${price(p.price)}`).join('; '))}">
        <line class="rb-axis" x1="${L}" x2="${W - R}" y1="34" y2="34"/>
        ${ticks.map((v) => `<line class="rb-axis" x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="30" y2="38"/>`).join('')}
        ${dots}
      </svg>
      <p class="rb-scale">${ticks.map((v) => `<span style="left:${((x(v) / W) * 100).toFixed(1)}%">${esc(price(v))}</span>`).join('')}</p></section>`;
  }

  function targets(d) {
    if (!d.targets.length) return '';
    return `<section class="rb-targets"><h2 class="when">Production numbers<span>units built, deployed or promised</span></h2><ol>${d.targets.slice(0, 6).map((t) => `<li>
      <b>${esc(units(t.units))}</b><span>${t.company ? `${esc(t.company.label)} · ` : ''}${t.year ? `by ${t.year} · ` : ''}<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a></span></li>`).join('')}</ol></section>`;
  }

  function card(x, i) {
    const d = data.d;
    const slot = slotOf(x.kind);
    const nums = [x.usd && usd(x.usd), x.price && price(x.price), x.units && `${units(x.units)} units`].filter(Boolean);
    return `<li class="rb-card" id="rb-${esc(x.id)}" style="--i:${Math.min(i, 14)}">
      <details${view.e === x.id ? ' open' : ''}>
        <summary>
          <p class="ct-meta"><span class="rb-kind s${slot + 1}">${esc(d.labels.kinds[x.kind])}</span>${x.company ? `<a class="tl-chip" href="${esc(href({ c: x.company.key }))}">${esc(x.company.label)}</a>` : ''}${x.form !== 'other' ? `<span class="rb-form">${esc(d.labels.forms[x.form])}</span>` : ''}</p>
          <h3>${esc(x.title)}</h3>
          <p class="ct-sub">${nums.length ? `<b class="rb-num">${esc(nums.join(' · '))}</b> · ` : ''}${esc(dayFmt(x.at))} · ${plural(x.outlets, 'outlet')}</p>
        </summary>
        <ol class="ct-events">${x.reports.map((e) => `<li><p class="ct-ev-h">${esc(dayFmt(e.at))}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.events.filter(matches);
    list.sort((a, b) => (b.id === view.e) - (a.id === view.e) || b.at - a.at);
    const s = d.stats;
    const change = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}% on the 90 days before` : 'none in the 90 days before');
    const us = d.regions.find((r) => r.key === 'us'), cn = d.regions.find((r) => r.key === 'china');
    const labels = [view.k && (view.k === 'deploy' ? 'Put to work or built' : d.labels.kinds[view.k]), view.c && (d.companies.find((c) => c.key === view.c)?.label || view.c), view.r && d.labels.regions[view.r], view.f && d.labels.forms[view.f]].filter(Boolean);
    const kinds = SERIES.map(([k, l]) => ({ key: k, label: l, n: d.kinds.filter((x) => x.key === k || (k === 'deploy' && x.key === 'production')).reduce((a, x) => a + x.n, 0) }));
    return `<div class="tl-stats">
        <p><b>${s.n90}</b><span>robotics events in the last 90 days (${esc(change(s.n90, s.prev90))})</span></p>
        <p><b>${esc(usd(s.raised))}</b><span>in ${plural(s.rounds, 'round')} named in a year, ${esc(usd(s.raised90))} in the last 90 days</span></p>
        <p><b>${Math.round(s.usShare90 * 100)}% · ${Math.round(s.chinaShare90 * 100)}%</b><span>of events naming a company were American · Chinese in 90 days (${us?.n90 || 0} · ${cn?.n90 || 0})</span></p>
        ${s.biggest ? `<p><b>${esc(usd(s.biggest.usd))}</b><span>biggest: ${esc(s.biggest.company?.label || s.biggest.title)}</span></p>` : ''}
      </div>
      <div class="rb-top">${columns(d, narrow)}${race(d, narrow)}</div>
      <div class="rb-grid">${companies(d)}${roundsList(d)}</div>
      ${prices(d, narrow)}
      ${targets(d)}
      <nav class="pd-chips ct-themes" aria-label="What happened"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '' }))}">All</a>${kinds.filter((k) => k.n).map((k) => `<a class="chip${view.k === k.key ? ' on' : ''}" href="${esc(href({ k: view.k === k.key ? '' : k.key }))}">${esc(k.label)} <small>${k.n}</small></a>`).join('')}
        <span class="in-sep"></span>${d.forms.filter((f) => f.n && f.key !== 'other').map((f) => `<a class="chip${view.f === f.key ? ' on' : ''}" href="${esc(href({ f: view.f === f.key ? '' : f.key }))}">${esc(f.label)} <small>${f.n}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Events')}<span>${list.length}, newest first${narrow && list.length > 30 ? ', 30 shown' : ''}</span>${labels.length ? '<a class="tl-clear" href="#robots">Show all</a>' : ''}</h2>
        <ol class="ct-cases">${list.slice(0, narrow ? 30 : 80).map(card).join('') || '<li class="rail-note">No events match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} robotics headlines in English over the last year. A headline is read for what happened (money, a robot unveiled, robots put to work or built, a new robot brain, a setback), the company and the kind of robot; one company's news of the same kind within a week is one event, and its funding news within three weeks is one round. Rounds count the money raised or paid, not valuations or talks. Companies are placed by where they're based; Nvidia and Google count when the headline is about their robotics. Robotaxis are on <a href="#incidents">AI incidents</a> and money across AI on <a href="#deals">Deals</a>. <a href="/api/robots">JSON</a></p>
      <div class="ac-tip rb-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#robotsView');
    document.title = `Robots · ${site}`;
    const head = `<header class="topic-head rb-head"><p class="kicker">Robots</p><h1>The robot race</h1>
      <p class="topic-sum">Humanoids, robot brains and the money behind them: who raised, who shipped, what robots cost, and how the US, China and Europe compare.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Robots need the live server.</p>`);
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
    setHtml(host, `${head}<div class="rb-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.e && scrolled !== view.e) {
      scrolled = view.e;
      // After the router's scroll to the top.
      requestAnimationFrame(() => document.getElementById(`rb-${view.e}`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
  }

  function hover(e) {
    const tip = $('#robotsView .rb-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.rb-col');
    const rc = t?.closest?.('.rb-rc');
    const pt = t?.closest?.('.rb-pt');
    const co = t?.closest?.('.rb-cos a');
    const rd = t?.closest?.('.rb-rounds a');
    let html = '';
    let el = null;
    if (col) {
      const m = d.months[+col.dataset.m];
      const vals = SERIES.map(() => 0);
      for (const [k, n] of Object.entries(m.kinds)) vals[slotOf(k)] += n;
      el = col;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p><p><b>${plural(m.n, 'event')}</b>${m.usd ? `, ${esc(usd(m.usd))} raised` : ''}</p>${SERIES.map(([k, l], s) => (vals[s] ? `<p><i class="sw" style="--c:${k === 'setback' ? 'var(--rb-grey)' : `var(--s${s + 1}c)`}"></i>${esc(l)}: <b>${vals[s]}</b></p>` : '')).join('')}`;
    } else if (rc) {
      const m = d.months[+rc.dataset.m];
      el = rc;
      html = `<p class="tt-h">${esc(d.labels.regions[rc.dataset.r])}, ${esc(monLong(m.m))}</p><p><b>${plural(m.regions[rc.dataset.r], 'event')}</b></p>`;
    } else if (pt) {
      const p = d.prices[+pt.dataset.p];
      el = pt.querySelector('circle');
      html = `<p class="tt-h">${esc(price(p.price))}${p.company ? ` · ${esc(p.company.label)}` : ''}</p><p>${esc(p.title)}</p><p><small>${esc(dayFmt(p.at))}</small></p>`;
    } else if (co) {
      const c = d.companies.find((x) => x.key === co.dataset.c);
      if (c) {
        el = co.querySelector('.rb-bar');
        html = `<p class="tt-h">${esc(c.label)}</p><p><b>${c.n}</b> events, ${c.n90} in the last 90 days${c.usd ? ` · ${esc(usd(c.usd))} raised` : ''}</p>${Object.entries(c.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<p>${esc(d.labels.kinds[k])}: <b>${n}</b></p>`).join('')}`;
      }
    } else if (rd) {
      const r = d.rounds.find((x) => x.id === rd.dataset.e);
      if (r) {
        el = rd.querySelector('.rb-bar');
        html = `<p class="tt-h">${esc(usd(r.usd))} · ${esc(r.company?.label || '')}</p><p>${esc(r.title)}</p><p><small>${esc(dayFmt(r.at))} · ${plural(r.outlets, 'outlet')}</small></p>`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#robotsView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
