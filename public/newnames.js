// New names (#new): models, products, projects and companies that entered
// the news in the last 60 days. An arrivals strip (one dot per name on the day
// it first appeared, sized by coverage) above a card per name: what it is in
// the articles' own words, whose it is, where it first appeared, and a
// sparkline of daily mentions. Server side: src/index/newnames.js.

const DAY = 86400e3;
const KIND = { model: 'Models', agent: 'Agents', tool: 'Tools', device: 'Devices', chip: 'Chips', company: 'Companies', project: 'Projects', security: 'Security', policy: 'Policy', other: 'Other' };
const ONE = { model: 'Model', agent: 'Agent', tool: 'Tool', device: 'Device', chip: 'Chip', company: 'Company', project: 'Project', security: 'Security', policy: 'Policy', other: 'New name' };
const SORTS = [['new', 'Newest'], ['most', 'Most covered'], ['rising', 'Rising']];
const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;

// Daily mentions since first seen: 2px line, last point marked.
function spark(series, from) {
  const vals = series.slice(Math.max(0, Math.min(from, series.length - 7)));
  const W = 120, H = 28, max = Math.max(1, ...vals);
  const pts = vals.map((v, i) => [(i / Math.max(1, vals.length - 1)) * (W - 4) + 2, H - 3 - (v / max) * (H - 6)]);
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="nn-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5"/></svg>`;
}

export function createNewNames({ $, esc, setHtml, state, reducedMotion }) {
  const view = { kind: '', sort: 'new' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#new(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.kind = KIND[p.get('kind')] ? p.get('kind') : '';
    view.sort = SORTS.some(([k]) => k === p.get('sort')) ? p.get('sort') : 'new';
    return 'newnames';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/new-names');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'newnames') render();
  }

  const href = (o) => {
    const p = new URLSearchParams();
    const kind = o.kind ?? view.kind;
    const sort = o.sort ?? view.sort;
    if (kind) p.set('kind', kind);
    if (sort !== 'new') p.set('sort', sort);
    const s = p.toString();
    return `#new${s ? `?${s}` : ''}`;
  };

  // Arrivals: a dot per name on the day it first appeared, piled up when
  // several arrived the same day; area by mentions.
  function arrivals(d, list, narrow) {
    const W = narrow ? 360 : 920, L = 8, R = 8;
    const x = (t) => L + ((t - d.since) / (d.days * DAY)) * (W - L - R);
    const maxM = Math.max(...d.names.map((n) => n.mentions));
    const r = (n) => 3.5 + Math.sqrt(n.mentions / maxM) * (narrow ? 8 : 12);
    // Biggest first, each resting on the axis or on the dots below it.
    const byMentions = [...d.names].sort((a, b) => b.mentions - a.mentions);
    const placed = new Map();
    for (const n of byMentions) {
      const cx = x(n.first.at);
      const rad = r(n);
      let cy = -rad;
      for (let k = 0; k < 60; k++) {
        const hit = [...placed.values()].find((p) => Math.hypot(p.cx - cx, p.cy - cy) < p.r + rad + 1.5);
        if (!hit) break;
        cy = hit.cy - Math.sqrt(Math.max(0, (hit.r + rad + 1.5) ** 2 - (hit.cx - cx) ** 2)) - 0.5;
      }
      placed.set(n, { cx, cy, r: rad });
    }
    // Labels for the biggest arrivals, above the top of their pile.
    const labels = [];
    for (const n of byMentions.slice(0, narrow ? 3 : 6)) {
      const p = placed.get(n);
      const top = Math.min(...[...placed.values()].filter((q) => Math.abs(q.cx - p.cx) < q.r + 26).map((q) => q.cy - q.r));
      const lx = Math.min(W - R - 2, Math.max(L + 2, p.cx));
      const ly = top - 7;
      if (labels.some((l) => Math.abs(l.x - lx) < (narrow ? 74 : 96) && Math.abs(l.y - ly) < 16)) continue;
      labels.push({ x: lx, y: ly, t: n.name, anchor: lx > W - 70 ? 'end' : lx < 70 ? 'start' : 'middle' });
    }
    const top = Math.min(-24, ...[...placed.values()].map((p) => p.cy - p.r - 4), ...labels.map((l) => l.y - 14));
    const H = -top + 24;
    const ticks = [];
    for (let i = 0; i <= d.days; i += narrow ? 20 : 10) ticks.push(d.since + i * DAY);
    return `<section class="nn-arrivals" aria-label="Arrivals"><h2 class="when">Arrivals<span>each dot is a new name on the day it first appeared · size is coverage since</span></h2>
      <svg viewBox="0 ${top.toFixed(1)} ${W} ${H.toFixed(1)}" class="nn-strip" role="group" aria-label="New names by the day they first appeared">
        <line class="nn-axis" x1="${L}" x2="${W - R}" y1="0" y2="0"/>
        ${ticks.map((t) => `<g class="nn-tick"><line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="0" y2="4"/><text x="${x(t).toFixed(1)}" y="18" text-anchor="${t === ticks[0] ? 'start' : t === ticks[ticks.length - 1] ? 'end' : 'middle'}">${esc(t >= d.generatedAt - DAY ? 'today' : dayFmt(t))}</text></g>`).join('')}
        ${byMentions.map((n) => {
          const p = placed.get(n);
          const on = list.includes(n);
          return `<circle class="nn-dot${on ? '' : ' off'}" style="--d:${Math.round((p.cx / W) * 700)}" cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="${p.r.toFixed(1)}" data-key="${esc(n.key)}" tabindex="${on ? 0 : -1}" role="button" aria-label="${esc(`${n.name}, first seen ${dayFmt(n.first.at)}, ${plural(n.mentions, 'mention')}`)}"><title>${esc(`${n.name} · first seen ${dayFmt(n.first.at)} · ${plural(n.mentions, 'mention')}`)}</title></circle>`;
        }).join('')}
        ${labels.map((l) => `<text class="nn-lab" x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="${l.anchor}">${esc(l.t)}</text>`).join('')}
      </svg></section>`;
  }

  function card(n, i, d) {
    const since = Math.floor((n.first.at - d.since) / DAY);
    const def = n.definition;
    const trend = n.trend === 'rising' ? '<span class="nn-trend up">↑ rising</span>' : n.trend === 'fading' ? '<span class="nn-trend down">↓ fading</span>' : '';
    return `<li class="nn-card" id="nn-${esc(n.key)}" style="--i:${Math.min(i, 14)}">
      <p class="nn-kind"><span>${esc(ONE[n.kind] || 'New name')}</span>${n.owner ? ` · <a href="#graph/${esc(n.owner.key)}">${esc(n.owner.label)}</a>` : ''}</p>
      <h3><a href="#search?q=${encodeURIComponent(`"${n.name}"`)}">${esc(n.name)}</a></h3>
      ${def ? `<blockquote class="nn-def"><p>${esc(def.text.charAt(0).toUpperCase() + def.text.slice(1))}${/[.!?]$/.test(def.text) ? '' : '.'}</p><footer><a href="${esc(def.url)}" target="_blank" rel="noopener">${esc(def.source)}</a>${def.agree > 1 ? ` · ${def.agree} outlets describe it this way` : ''}</footer></blockquote>` : '<p class="nn-def none">No outlet has said what it is in so many words yet.</p>'}
      <div class="nn-stats">${spark(n.series, since)}<p><b>${n.mentions}</b> mentions · <b>${n.outlets}</b> outlets ${trend}</p></div>
      <p class="nn-first">First: <a href="${esc(n.first.url)}" target="_blank" rel="noopener"><img src="${esc(fav(hostOf(n.first.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(n.first.source)}</a> · ${esc(dayFmt(n.first.at))}</p>
      ${n.headlines.length ? `<details class="nn-more"><summary>Latest coverage</summary><ul>${n.headlines.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><small>${esc(h.source)} · ${esc(dayFmt(h.at))}</small></li>`).join('')}</ul></details>` : ''}
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.names.filter((n) => !view.kind || n.kind === view.kind);
    const sorted = view.sort === 'most' ? [...list].sort((a, b) => b.mentions - a.mentions)
      : view.sort === 'rising' ? [...list].sort((a, b) => (b.trend === 'rising') - (a.trend === 'rising') || b.week - a.week)
      : list;
    const counts = {};
    for (const n of d.names) counts[n.kind] = (counts[n.kind] || 0) + 1;
    const kinds = Object.keys(KIND).filter((k) => counts[k]);
    return `${arrivals(d, list, narrow)}
      <div class="nn-bar">
        <nav class="pd-chips" aria-label="Kind"><a class="chip${view.kind ? '' : ' on'}" href="${esc(href({ kind: '' }))}">All<small>${d.names.length}</small></a>${kinds.map((k) => `<a class="chip${view.kind === k ? ' on' : ''}" href="${esc(href({ kind: k }))}">${KIND[k]}<small>${counts[k]}</small></a>`).join('')}</nav>
        <nav class="nn-sort" aria-label="Sort">${SORTS.map(([k, l]) => `<a href="${esc(href({ sort: k }))}"${view.sort === k ? ' aria-current="true"' : ''}>${l}</a>`).join('')}</nav>
      </div>
      ${sorted.length ? `<ol class="nn-cards">${sorted.map((n, i) => card(n, i, d)).join('')}</ol>` : '<p class="rail-note">Nothing new of this kind lately.</p>'}
      <p class="rail-note nn-how">A new name is one that outlets started using in the last ${d.days} days and that barely appears in the archive before then. Definitions are the articles’ own words, picked where most outlets agree. <a href="/api/new-names">JSON</a></p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#newnamesView');
    document.title = `New names · ${site}`;
    const head = `<header class="topic-head nn-head"><p class="kicker">New names</p><h1>What’s that?</h1>
      <p class="topic-sum">Models, products and projects that entered the news in the last 60 days, and what they are.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">New names need the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:130px;display:block;margin:16px 0;border-radius:12px"></i><i class="skeleton" style="height:320px;display:block;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== d && !reducedMotion();
    drawn = d;
    setHtml(host, `${head}<div class="nn-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  // A dot on the strip jumps to its card and flashes it.
  function onClick(e) {
    const dot = e.target.closest('.nn-dot');
    if (!dot) return;
    const el = document.getElementById(`nn-${dot.dataset.key}`);
    if (!el) return;
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function onKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.nn-dot')) {
      e.preventDefault();
      onClick(e);
    }
  }

  return { route, render, onClick, onKey };
}
