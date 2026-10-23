// AI incidents (#incidents?k=<kind>&p=<product>&o=<response>&w=lab|world&i=<id>):
// when AI went wrong. A year of incidents as a timeline with one lane per
// kind of failure (each dot an incident, sized by how many outlets carried
// it; tap one to open its card), products and responses as bars that
// filter, and incident cards with every report. Server side:
// src/index/incidents.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const DAY = 86400e3;
// Lane names that fit a phone.
const SHORT = { agents: 'Agents', vehicles: 'Robotaxis', harm: 'Harm', scams: 'Scams', images: 'Deepfakes', security: 'Hacks, leaks', influence: 'Propaganda', errors: 'Made-up', bias: 'Bias' };

export function createIncidents({ $, esc, setHtml, state, reducedMotion }) {
  const view = { k: '', p: '', o: '', w: '', i: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let scrolled = '';

  function route(hash) {
    const m = /^#incidents(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.k = (p.get('k') || '').replace(/[^a-z]/g, '');
    view.p = (p.get('p') || '').replace(/[^a-z]/g, '');
    view.o = (p.get('o') || '').replace(/[^a-z]/g, '');
    view.w = ['lab', 'world'].includes(p.get('w')) ? p.get('w') : '';
    view.i = (p.get('i') || '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
    return 'incidents';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/incidents');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'incidents') render();
  }

  const href = (over = {}) => {
    const v = { ...view, i: '', ...over };
    const p = new URLSearchParams();
    for (const k of ['k', 'p', 'o', 'w', 'i']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#incidents${s ? `?${s}` : ''}`;
  };

  const matches = (x, skip = '') => (skip === 'k' || !view.k || x.kind === view.k)
    && (skip === 'p' || !view.p || x.product?.key === view.p)
    && (skip === 'o' || !view.o || x.responses.includes(view.o))
    && (!view.w || (view.w === 'lab') === x.lab);

  // One lane per kind; x is time over the year, a dot's area the outlets.
  function lanes(d, narrow) {
    const kinds = d.kinds.filter((k) => k.n);
    const W = narrow ? 360 : 1000, LW = narrow ? 92 : 190, R = 10, T = 6, LH = narrow ? 30 : 34, B = 22;
    const H = T + kinds.length * LH + B;
    const t1 = d.generatedAt, t0 = t1 - d.days * DAY;
    const x = (t) => LW + ((t - t0) / (t1 - t0)) * (W - LW - R);
    const rOf = (n) => Math.min(narrow ? 9 : 12, 2.6 + 2.4 * Math.sqrt(n - 1));
    // Month boundaries as faint guides.
    const guides = [];
    const g = new Date(t0);
    g.setUTCDate(1);
    g.setUTCHours(0, 0, 0, 0);
    for (g.setUTCMonth(g.getUTCMonth() + 1); g.getTime() < t1; g.setUTCMonth(g.getUTCMonth() + 1)) guides.push(g.getTime());
    const rows = kinds.map((k, li) => {
      const cy = T + li * LH + LH / 2;
      const on = view.k === k.key;
      // Small ones first so the widest sit on top.
      const dots = d.incidents.filter((x) => x.kind === k.key).sort((a, b) => a.outlets - b.outlets).map((inc) => {
        const dim = !matches(inc, 'k');
        return `<a href="${esc(href({ i: inc.id, k: view.k }))}" class="in-dot${dim ? ' off' : ''}${view.i === inc.id ? ' sel' : ''}" data-id="${esc(inc.id)}"><circle cx="${x(inc.at).toFixed(1)}" cy="${cy}" r="${rOf(inc.outlets).toFixed(1)}"/></a>`;
      }).join('');
      return `<g class="in-lane${on ? ' on' : ''}${view.k && !on ? ' dim' : ''}" style="--i:${li}">
        <line class="in-track" x1="${LW}" x2="${W - R}" y1="${cy}" y2="${cy}"/>
        <a href="${esc(href({ k: on ? '' : k.key }))}" class="in-lab"><text x="${LW - 10}" y="${cy}" dy="0.32em" text-anchor="end">${esc(narrow ? SHORT[k.key] || k.label : k.label)}</text></a>
        <g class="in-dots">${dots}</g></g>`;
    }).join('');
    return `<section class="in-time"><h2 class="when">A year of incidents<span>each dot one incident, bigger when more outlets carried it; tap a dot to open it, a lane to filter</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(kinds.map((k) => `${k.label}: ${k.n} incidents, ${k.n90} in the last 90 days`).join('; '))}">
        ${guides.map((t) => `<g class="lc-tick"><line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${T}" y2="${H - B}"/></g><text class="lc-xt" x="${(x(t) + 3).toFixed(1)}" y="${H - 6}">${esc(monFmt(t))}</text>`).filter((_, i) => !narrow || i % 2 === 0).join('')}
        ${rows}
      </svg></section>`;
  }

  function bars(title, sub, rows, key, labelOf) {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return `<section class="in-bars"><h2 class="when">${esc(title)}<span>${esc(sub)}</span></h2>
      <ol>${rows.map((r, i) => {
        const on = view[key] === r.key;
        return `<li style="--i:${i}"><a href="${esc(href({ [key]: on ? '' : r.key }))}" class="${on ? 'on' : ''}${view[key] && !on ? ' dim' : ''}" data-${key}="${esc(r.key)}">
          <span class="in-bl">${esc(labelOf(r))}</span><span class="in-bar" style="width:${((100 * r.n) / max).toFixed(1)}%"></span><small>${r.n}</small></a></li>`;
      }).join('')}</ol></section>`;
  }

  function card(x, i) {
    const d = data.d;
    return `<li class="in-card" id="inc-${esc(x.id)}" style="--i:${Math.min(i, 14)}">
      <details${view.i === x.id ? ' open' : ''}>
        <summary>
          <p class="ct-meta"><span class="in-kind">${esc(d.labels.kinds[x.kind])}</span>${x.product ? `<a class="tl-chip" href="${esc(href({ p: x.product.key }))}">${esc(x.product.label)}</a>` : ''}${x.lab ? '<span class="in-lab-tag">In a lab or study</span>' : ''}</p>
          <h3>${esc(x.title)}</h3>
          <p class="ct-sub">${esc(dayFmt(x.at))}${x.last - x.at > DAY ? ` to ${esc(dayFmt(x.last))}` : ''} · ${plural(x.outlets, 'outlet')}</p>
          ${x.responses.length ? `<p class="in-resp">${x.responses.map((r) => `<span>${esc(d.labels.responses[r])}</span>`).join('')}</p>` : ''}
        </summary>
        <ol class="ct-events">${x.reports.map((e) => `<li><p class="ct-ev-h">${esc(dayFmt(e.at))}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.incidents.filter((x) => matches(x));
    // The one asked for first, then the most carried of the last month, then by date.
    const recent = d.generatedAt - 30 * DAY;
    list.sort((a, b) => (b.id === view.i) - (a.id === view.i) || (b.at >= recent) - (a.at >= recent) || (a.at >= recent && b.at >= recent ? b.outlets - a.outlets : 0) || b.at - a.at);
    const s = d.stats;
    const change = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}% on the 90 days before` : 'none in the 90 days before');
    const top = d.products[0];
    const labels = [view.k && d.labels.kinds[view.k], view.p && d.products.find((p) => p.key === view.p)?.label, view.o && d.labels.responses[view.o], view.w === 'lab' && 'in labs and studies', view.w === 'world' && 'in the world'].filter(Boolean);
    return `<div class="tl-stats">
        <p><b>${s.n90}</b><span>incidents in the last 90 days (${esc(change(s.n90, s.prev90))})</span></p>
        <p><b>${s.agents90}</b><span>with AI agents in 90 days, ${s.agentsPrev90} in the 90 before</span></p>
        <p><b>${Math.round(s.answeredShare * 100)}%</b><span>followed by a pause, ban, fix, apology, probe or lawsuit</span></p>
        ${top ? `<p><b>${esc(top.label.replace(/ \(.*\)$/, ''))}</b><span>named most: ${plural(top.n, 'incident')}</span></p>` : ''}
      </div>
      ${lanes(d, narrow)}
      <div class="in-grid">
        ${bars('Products', 'tap to filter', d.products.slice(0, 10), 'p', (r) => r.label)}
        ${bars('What was done about it', 'tap to filter', d.responses.filter((r) => r.n), 'o', (r) => r.label)}
      </div>
      <nav class="pd-chips ct-themes" aria-label="Kind"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '' }))}">All</a>${d.kinds.filter((k) => k.n).map((k) => `<a class="chip${view.k === k.key ? ' on' : ''}" href="${esc(href({ k: view.k === k.key ? '' : k.key }))}">${esc(k.label)} <small>${k.n}</small></a>`).join('')}
        <span class="in-sep"></span><a class="chip${view.w === 'world' ? ' on' : ''}" href="${esc(href({ w: view.w === 'world' ? '' : 'world' }))}">In the world</a><a class="chip${view.w === 'lab' ? ' on' : ''}" href="${esc(href({ w: view.w === 'lab' ? '' : 'lab' }))}">In labs and studies</a></nav>
      <section><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Incidents')}<span>${list.length}; the last month’s most carried first${narrow && list.length > 30 ? ', 30 shown' : ''}</span>${labels.length ? '<a class="tl-clear" href="#incidents">Show all</a>' : ''}</h2>
        <ol class="ct-cases">${list.slice(0, narrow ? 30 : 80).map(card).join('') || '<li class="rail-note">No incidents match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} headlines in English over the last year. A headline is read for what went wrong, the product or company involved, what was done about it and whether it happened in a lab or a study; reports of the same kind of failure with the same product within five days are one incident. Coverage we keep is denser in recent months, so the timeline fills up toward today. Outages are on <a href="#uptime">AI status</a>, lawsuits on <a href="#court">Courtroom</a>. <a href="/api/incidents">JSON</a></p>
      <div class="ac-tip in-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#incidentsView');
    document.title = `AI incidents · ${site}`;
    const head = `<header class="topic-head in-head"><p class="kicker">AI incidents</p><h1>When AI goes wrong</h1>
      <p class="topic-sum">Rogue agents, hacks and leaks, deepfakes, scams, harm and made-up answers: what happened, which product, and what was done about it.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">AI incidents need the live server.</p>`);
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
    setHtml(host, `${head}<div class="in-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.i && scrolled !== view.i) {
      scrolled = view.i;
      document.getElementById(`inc-${view.i}`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function hover(e) {
    const tip = $('#incidentsView .in-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const dot = t?.closest?.('.in-dot');
    const bar = t?.closest?.('.in-bars a');
    let html = '';
    let el = null;
    if (dot) {
      const x = d.incidents.find((i) => i.id === dot.dataset.id);
      if (x) {
        el = dot;
        html = `<p class="tt-h">${esc(x.title)}</p><p>${esc(dayFmt(x.at))} · ${plural(x.outlets, 'outlet')}${x.product ? ` · ${esc(x.product.label)}` : ''}</p>${x.responses.length ? `<p><small>${esc(x.responses.map((r) => d.labels.responses[r]).join(', '))}</small></p>` : ''}`;
      }
    } else if (bar) {
      const p = bar.dataset.p && d.products.find((r) => r.key === bar.dataset.p);
      if (p) {
        el = bar.querySelector('.in-bar');
        html = `<p class="tt-h">${esc(p.label)}</p><p><b>${p.n}</b> incidents, ${p.n90} in the last 90 days</p>${Object.entries(p.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<p>${esc(d.labels.kinds[k])}: <b>${n}</b></p>`).join('')}`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#incidentsView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
