// The buildout (#buildout?tab=&p=&k=&m=): AI data centers. Month-by-month
// project, power and pushback news as stacked columns, the share of it that's
// pushback, a US tile map (projects or pushback) with the rest of the world
// beside it, then tabs: projects with their size, money, power and status;
// pushback by place and kind; power sources and builders. Tapping a state or
// region filters the tabs to it. Server side: src/index/buildout.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'short' });
const monLong = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const money = (v) => (v >= 1e12 ? `$${+(v / 1e12).toFixed(1)}T` : v >= 1e9 ? `$${Math.round(v / 1e9)}B` : `$${Math.round(v / 1e6)}M`);
const gwFmt = (g) => (g >= 1 ? `${+g.toFixed(1)} GW` : `${Math.round(g * 1000)} MW`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const SERIES = [['project', 'Projects'], ['pushback', 'Pushback'], ['power', 'Power and grid']];
const STATUS = { announced: 'Announced', approved: 'Approved', construction: 'Building', online: 'Online', cancelled: 'Cancelled' };
const RAIL = ['announced', 'approved', 'construction', 'online'];
const TABS = [['projects', 'Projects'], ['pushback', 'Pushback'], ['power', 'Power and builders']];

// US tile grid (col, row), as in the server's STATES.
const TILES = {
  AK: [0, 0], ME: [11, 0], VT: [10, 1], NH: [11, 1], WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6], HI: [0, 7], TX: [4, 7], FL: [9, 7],
};

export function createBuildout({ $, esc, setHtml, state, reducedMotion }) {
  const view = { tab: 'projects', p: '', k: '', m: 'projects' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#buildout(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.tab = TABS.some(([k]) => k === p.get('tab')) ? p.get('tab') : 'projects';
    view.p = (p.get('p') || '').replace(/[^A-Za-z-]/g, '');
    view.k = (p.get('k') || '').replace(/[^a-z]/g, '');
    view.m = p.get('m') === 'push' ? 'push' : 'projects';
    return 'buildout';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/buildout');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'buildout') render();
  }

  const href = (o = {}) => {
    const v = { ...view, ...o };
    const p = new URLSearchParams();
    if (v.tab !== 'projects') p.set('tab', v.tab);
    if (v.p) p.set('p', v.p);
    if (v.k) p.set('k', v.k);
    if (v.m !== 'projects') p.set('m', 'push');
    const s = p.toString();
    return `#buildout${s ? `?${s}` : ''}`;
  };

  // Stacked columns per month; a 2px surface gap between segments.
  function months(d, narrow) {
    const W = narrow ? 360 : 560, H = 200, L = 30, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.project + m.pushback + m.power));
    const step = max > 120 ? 50 : max > 60 ? 20 : max > 20 ? 10 : 5;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      let acc = 0;
      const segs = SERIES.map(([k], s) => {
        const v = m[k];
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="bo-seg s${s + 1}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="bo-col" style="--i:${i}" data-m="${i}">${segs}<rect class="bo-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section class="bo-months"><h2 class="when">Month by month<span>stories, each counted once</span></h2>
      <ul class="tr-legend">${SERIES.map(([, l], s) => `<li style="--c:var(--s${s + 1}c)"><i class="sw"></i>${esc(l)}</li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${m.m}: ${m.project} projects, ${m.pushback} pushback, ${m.power} power`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // Pushback as a share of all buildout news, per month: robust to how much
  // we happened to collect that month.
  function share(d, narrow) {
    const W = narrow ? 360 : 560, H = 200, L = 34, R = 10, T = 12, B = 22;
    const pts = d.months.map((m) => {
      const n = m.project + m.pushback + m.power;
      return n >= 5 ? Math.round((100 * m.pushback) / n) : null;
    });
    const xs = (i) => L + (i + 0.5) * ((W - L - R) / d.months.length);
    const y = (v) => T + (1 - v / 100) * (H - T - B);
    let path = '';
    pts.forEach((v, i) => { if (v != null) path += `${path && pts[i - 1] != null ? 'L' : 'M'}${xs(i).toFixed(1)},${y(v).toFixed(1)}`; });
    const lastI = pts.findLastIndex((v) => v != null);
    return `<section class="bo-share"><h2 class="when">How much of it is pushback<span>share of the month’s buildout stories</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m, i) => `${m.m}: ${pts[i] == null ? 'too few stories' : `${pts[i]}%`}`).join('; '))}">
        ${[0, 25, 50, 75, 100].map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}%</text></g>`).join('')}
        <path class="bo-line" d="${path}" pathLength="1"/>
        ${pts.map((v, i) => (v == null ? '' : `<g class="bo-pt" data-s="${i}"><circle cx="${xs(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === lastI ? 5 : 3.5}"/><rect class="bo-hit" x="${(xs(i) - (W - L - R) / d.months.length / 2).toFixed(1)}" y="${T}" width="${((W - L - R) / d.months.length).toFixed(1)}" height="${H - T - B}"/></g>`)).join('')}
        ${lastI >= 0 ? `<text class="bo-end" x="${(xs(lastI) - 8).toFixed(1)}" y="${(y(pts[lastI]) - 10).toFixed(1)}" text-anchor="end">${pts[lastI]}%</text>` : ''}
        ${d.months.map((m, i) => (i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${xs(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : '')).join('')}
      </svg></section>`;
  }

  // US tiles, shaded by projects or pushback (one hue, light to dark), and
  // the rest of the world as bars.
  function map(d) {
    const push = view.m === 'push';
    const val = (x) => (push ? x.pushback : x.projects);
    const us = new Map(d.places.filter((x) => x.us).map((x) => [x.key, x]));
    const max = Math.max(1, ...[...us.values()].map(val));
    const level = (v) => (v ? Math.min(4, 1 + Math.floor(3.999 * Math.sqrt(v / max))) : 0);
    const S = 36, G = 4;
    const tiles = Object.entries(TILES).map(([code, [c, r]], i) => {
      const x = us.get(code);
      const v = x ? val(x) : 0;
      const on = view.p === code;
      return `<a href="${esc(href({ p: on ? '' : code }))}" class="bo-tile l${level(v)}${on ? ' on' : ''}${view.p && !on ? ' dim' : ''}" data-st="${code}" style="--i:${c + r}" aria-label="${esc(`${x?.label || code}: ${plural(x?.projects || 0, 'project')}, ${x?.pushback || 0} pushback`)}">
        <rect x="${c * (S + G)}" y="${r * (S + G)}" width="${S}" height="${S}" rx="6"/><text x="${c * (S + G) + S / 2}" y="${r * (S + G) + S / 2}" dy="0.35em" text-anchor="middle">${code}</text></a>`;
    }).join('');
    const world = d.places.filter((x) => !x.us && val(x)).sort((a, b) => val(b) - val(a)).slice(0, 9);
    const wmax = Math.max(1, ...world.map(val));
    return `<section class="bo-map"><h2 class="when">Where<span>tap a place to filter</span>
        <span class="bo-mode" role="group" aria-label="Shade by"><a href="${esc(href({ m: 'projects' }))}" class="${push ? '' : 'on'}">Projects</a><a href="${esc(href({ m: 'push' }))}" class="${push ? 'on' : ''}">Pushback</a></span></h2>
      <div class="bo-map-grid ${push ? 'push' : ''}">
        <svg viewBox="0 0 ${12 * (S + G) - G} ${8 * (S + G) - G}" role="img" aria-label="${esc(`US states by ${push ? 'pushback stories' : 'projects'}`)}">${tiles}</svg>
        <div class="bo-world"><h3>Outside the US</h3>
          <ol>${world.map((x, i) => `<li style="--i:${i}"><a href="${esc(href({ p: view.p === x.key ? '' : x.key }))}" class="${view.p === x.key ? 'on' : ''}"><span>${esc(x.label)}</span><i class="bo-wbar"><b style="width:${((100 * val(x)) / wmax).toFixed(1)}%"></b></i><small>${val(x)}</small></a></li>`).join('') || '<li class="rail-note">None yet.</li>'}</ol>
        </div>
      </div>
      <p class="bo-key"><span>Fewer</span>${[1, 2, 3, 4].map((l) => `<i class="l${l}"></i>`).join('')}<span>More ${push ? 'pushback stories' : 'projects'}</span></p>
    </section>`;
  }

  function rail(status) {
    if (status === 'cancelled') return '<span class="bo-rail x" aria-label="Cancelled"><i></i><i></i><i></i><i></i></span>';
    const at = RAIL.indexOf(status);
    return `<span class="bo-rail" aria-label="${esc(STATUS[status])}">${RAIL.map((s, i) => `<i class="${i <= at ? 'on' : ''}" title="${esc(STATUS[s])}"></i>`).join('')}</span>`;
  }

  function projectCard(p, i, maxGw) {
    return `<li class="bo-proj" style="--i:${Math.min(i, 14)}">
      <details>
        <summary>
          <p class="bo-meta"><span class="bo-status ${p.status}">${STATUS[p.status]}</span>${rail(p.status)}${p.power.map((k) => `<span class="bo-pw">${esc(data.d.labels.power[k] || k)}</span>`).join('')}${p.pushback ? '<span class="bo-pw push">Pushback</span>' : ''}</p>
          <h3>${esc(p.name)}</h3>
          <p class="bo-size">${p.gw ? `<b>${esc(gwFmt(p.gw))}</b><i class="bo-gw"><b style="width:${Math.max(2, (100 * Math.sqrt(p.gw / maxGw))).toFixed(1)}%"></b></i>` : ''}${p.amount ? `<b class="bo-amt">${esc(money(p.amount))}</b>` : ''}</p>
          <p class="bo-sub">${esc(dayFmt(p.first))}${p.last - p.first > 86400e3 ? ` to ${esc(dayFmt(p.last))}` : ''} · ${plural(p.outlets, 'outlet')}</p>
          <p class="bo-latest">${esc(p.events.at(-1).title)}</p>
        </summary>
        <ol class="ct-events">${[...p.events].reverse().map((e) => `<li class="k-${e.kind === 'pushback' ? 'ruling' : 'filed'}"><p class="ct-ev-h"><b>${e.kind === 'pushback' ? 'Pushback' : 'Project'}</b> · ${esc(dayFmt(e.at))}${e.outlets > 1 ? ` · ${e.outlets} outlets` : ''}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function projectsTab(d) {
    const list = d.projects.filter((p) => !view.p || p.place?.key === view.p);
    const maxGw = Math.max(1, ...d.projects.map((p) => p.gw || 0));
    return `<ol class="bo-projs">${list.slice(0, 60).map((p, i) => projectCard(p, i, maxGw)).join('') || '<li class="rail-note">No projects here yet.</li>'}</ol>`;
  }

  function pushbackTab(d) {
    const list = d.pushback.filter((e) => (!view.p || e.place?.key === view.p) && (!view.k || e.kinds.includes(view.k)));
    return `<nav class="pd-chips bo-kinds" aria-label="Kind of pushback"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '' }))}">All</a>${d.pushKinds.map((k) => `<a class="chip${view.k === k.key ? ' on' : ''}" href="${esc(href({ k: view.k === k.key ? '' : k.key }))}">${esc(k.label)} <small>${k.n}</small></a>`).join('')}</nav>
      <ol class="bo-push">${list.slice(0, 60).map((e, i) => `<li style="--i:${Math.min(i, 14)}">
        <p class="bo-push-h">${e.kinds.map((k) => `<span class="bo-kind k-${k}">${esc(d.labels.push[k])}</span>`).join('')}${e.place ? `<a class="bo-place" href="${esc(href({ p: e.place.key }))}">${esc(e.place.label)}</a>` : ''}<time>${esc(dayFmt(e.at))}</time></p>
        <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}${e.outlets > 1 ? ` and ${e.outlets - 1} more` : ''}</small></p>
      </li>`).join('') || '<li class="rail-note">No pushback stories match.</li>'}</ol>`;
  }

  function powerTab(d) {
    const pmax = Math.max(1, ...d.power.map((p) => p.n));
    return `<div class="bo-two">
      <section><h3 class="bo-h3">What powers it<span>stories naming each source</span></h3>
        <ol class="bo-bars">${d.power.map((p, i) => `<li style="--i:${i}"><p><b>${esc(p.label)}</b><small>${p.n}${p.recent ? ` · ${p.recent} in 90 days` : ''}</small></p><i class="bo-wbar"><b style="width:${((100 * p.n) / pmax).toFixed(1)}%"></b></i>${p.latest ? `<a href="${esc(p.latest.url)}" target="_blank" rel="noopener">${esc(p.latest.title)}</a>` : ''}</li>`).join('')}</ol>
      </section>
      <section><h3 class="bo-h3">Who’s building<span>placed projects</span></h3>
        <table class="bo-table"><thead><tr><th scope="col">Builder</th><th scope="col">Projects</th><th scope="col">Capacity</th><th scope="col">Money</th></tr></thead>
        <tbody>${d.builders.map((b) => `<tr><th scope="row">${esc(b.label)}<small>${esc(b.places.join(', '))}</small></th><td>${b.projects}</td><td>${b.gw ? esc(gwFmt(b.gw)) : '–'}</td><td>${b.amount ? esc(money(b.amount)) : '–'}</td></tr>`).join('')}</tbody></table>
      </section></div>`;
  }

  function placePanel(d) {
    const x = d.places.find((p) => p.key === view.p);
    if (!x) return '';
    const kinds = Object.entries(x.kinds).sort((a, b) => b[1] - a[1]);
    return `<aside class="bo-placecard"><h3>${esc(x.label)}</h3>
      <p>${plural(x.projects, 'project')}${x.gw ? ` · ${esc(gwFmt(x.gw))}` : ''} · ${x.pushback} pushback stor${x.pushback === 1 ? 'y' : 'ies'}${x.push90 ? ` (${x.push90} in 90 days)` : ''}</p>
      ${kinds.length ? `<p class="bo-meta">${kinds.map(([k, n]) => `<span class="bo-kind k-${k}">${esc(d.labels.push[k])} ${n}</span>`).join('')}</p>` : ''}
      <a class="tl-clear" href="${esc(href({ p: '' }))}">Show everywhere</a></aside>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const s = d.stats;
    const trend = s.pushShare30 != null && s.pushSharePrev != null ? s.pushShare30 - s.pushSharePrev : null;
    const counts = {
      projects: d.projects.filter((p) => !view.p || p.place?.key === view.p).length,
      pushback: d.pushback.filter((e) => !view.p || e.place?.key === view.p).length,
    };
    return `<div class="tl-stats">
        <p><b>${esc(gwFmt(s.gw))}</b><span>in ${s.projects} placed projects</span></p>
        <p><b>${esc(money(s.amount))}</b><span>attached to projects two or more outlets covered</span></p>
        <p><b>${s.placesSayingNo}</b><span>places that paused, banned or rejected data centers in 90 days</span></p>
        ${s.pushShare30 != null ? `<p><b>${s.pushShare30}%</b><span>of the last 30 days’ stories are pushback${trend ? ` (${trend > 0 ? '+' : ''}${trend} point${Math.abs(trend) === 1 ? '' : 's'} on the months before)` : ''}</span></p>` : ''}
      </div>
      <div class="bo-charts">${months(d, narrow)}${share(d, narrow)}</div>
      ${map(d)}
      ${placePanel(d)}
      <nav class="bo-tabs" role="tablist" aria-label="Sections">${TABS.map(([k, l]) => `<a role="tab" aria-selected="${view.tab === k}" class="${view.tab === k ? 'on' : ''}" href="${esc(href({ tab: k }))}">${esc(l)}${counts[k] != null ? ` <small>${counts[k]}</small>` : ''}</a>`).join('')}</nav>
      <section class="bo-tab" role="tabpanel">${view.tab === 'pushback' ? pushbackTab(d) : view.tab === 'power' ? powerTab(d) : projectsTab(d)}</section>
      <p class="rail-note">From ${d.headlines.toLocaleString('en')} data center headlines in English over the last year. A headline is read for who is building, where, how big, how much and what powers it, and for a town or state saying no; the same builder in the same place is one project. Sizes are the largest figure a headline gives for the site; fleet-wide goals and chip deals don’t count. Recent months hold more stories partly because we keep more recent coverage, which is why the share chart matters. <a href="/api/buildout">JSON</a></p>
      <div class="ac-tip bo-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#buildoutView');
    document.title = `The buildout · ${site}`;
    const head = `<header class="topic-head bo-head"><p class="kicker">The buildout</p><h1>Where AI gets built, and where towns say no</h1>
      <p class="topic-sum">AI data centers: who is building what and where, how many gigawatts, what powers them, and the moratoriums, bans and protests pushing back.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The buildout needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="bo-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  function place(tip, el, html) {
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#buildoutView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 6)}px`;
  }

  function hover(e) {
    const tip = $('#buildoutView .bo-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.bo-col');
    const pt = t?.closest?.('.bo-pt');
    const tile = t?.closest?.('.bo-tile');
    if (col) {
      const m = d.months[+col.dataset.m];
      place(tip, col, `<p class="tt-h">${esc(monLong(m.m))}</p>${SERIES.map(([k, l], s) => `<p><i class="ct-sw s${s + 1}"></i>${esc(l)}: <b>${m[k]}</b></p>`).join('')}`);
    } else if (pt) {
      const m = d.months[+pt.dataset.s];
      const n = m.project + m.pushback + m.power;
      place(tip, pt.querySelector('circle'), `<p class="tt-h">${esc(monLong(m.m))}</p><p><b>${Math.round((100 * m.pushback) / n)}%</b> pushback</p><p>${m.pushback} of ${n} stories</p>`);
    } else if (tile) {
      const x = d.places.find((p) => p.key === tile.dataset.st);
      const kinds = x ? Object.entries(x.kinds).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
      place(tip, tile, `<p class="tt-h">${esc(x?.label || tile.dataset.st)}</p>${x ? `<p>${plural(x.projects, 'project')}${x.gw ? ` · ${esc(gwFmt(x.gw))}` : ''}</p><p>${x.pushback} pushback stor${x.pushback === 1 ? 'y' : 'ies'}</p>${kinds.length ? `<p>${kinds.map(([k, n]) => `${esc(d.labels.push[k])} ${n}`).join(' · ')}</p>` : ''}${x.headlines[0] ? `<p class="tt-sub">${esc(x.headlines[0].title)}</p>` : ''}` : '<p>Nothing in our headlines yet</p>'}`);
    } else tip.hidden = true;
  }

  return { route, render, hover };
}
