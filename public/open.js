// Open weights (#open?r=<region>&l=<lab>&m=<modality>&e=<id>): the year's
// open model releases. Monthly releases stacked by where the lab is based,
// model sizes over time on a log scale (a line down to the active
// parameters for mixture-of-experts models), labs that filter, whose open
// weights other companies build on, and release cards with every report.
// Server side: src/index/openweights.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const monLong = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const params = (b) => (b >= 1000 ? `${+(b / 1000).toPrecision(3)}T` : b >= 1 ? `${+b.toPrecision(3)}B` : `${Math.round(b * 1000)}M`);
const ctx = (n) => (n >= 1e6 ? `${+(n / 1e6).toPrecision(3)}M context` : `${Math.round(n / 1e3)}K context`);
const DAY = 86400e3;
const REGIONS = ['us', 'china', 'europe', 'other'];
const SHORT = { us: 'US', china: 'China', europe: 'Europe', other: 'Elsewhere' };

export function createOpen({ $, esc, setHtml, state, reducedMotion }) {
  const view = { r: '', l: '', m: '', e: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let scrolled = '';

  function route(hash) {
    const m = /^#open(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    for (const k of ['r', 'l', 'm']) view[k] = (p.get(k) || '').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    view.e = (p.get('e') || '').replace(/[^a-z0-9.-]/g, '').slice(0, 80);
    return 'open';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/open');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'open') render();
  }

  const href = (over = {}) => {
    const v = { ...view, e: '', ...over };
    const p = new URLSearchParams();
    for (const k of ['r', 'l', 'm', 'e']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#open${s ? `?${s}` : ''}`;
  };
  const matches = (x) => (!view.r || x.lab.region === view.r) && (!view.l || x.lab.key === view.l) && (!view.m || x.modality === view.m);
  const slot = (region) => REGIONS.indexOf(region) + 1;

  function columns(d, narrow) {
    const W = narrow ? 360 : 560, H = 210, L = 28, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.n));
    const step = max > 40 ? 10 : max > 16 ? 5 : 2;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      let acc = 0;
      const segs = REGIONS.map((r, s) => {
        const v = m.regions[r];
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="ow-seg s${s + 1}${view.r && view.r !== r ? ' dim' : ''}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="ow-col" style="--i:${i}" data-m="${i}">${segs}<rect class="ow-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section><h2 class="when">Releases<span>open models by month, by where the lab is based</span></h2>
      <ul class="tr-legend">${d.regions.map((r, s) => `<li style="--c:var(--s${s + 1}c)"><a href="${esc(href({ r: view.r === r.key ? '' : r.key }))}" class="ow-leg${view.r === r.key ? ' on' : ''}"><i class="sw"></i>${esc(r.label)}</a></li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${monLong(m.m)}: ${plural(m.n, 'release')}`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // Sizes over the year on a log scale: a dot for the total parameters, a
  // line down to the active ones when the model is a mixture of experts.
  function sizes(d, narrow) {
    const list = d.sizes.filter((s) => (!view.r || s.lab.region === view.r) && (!view.l || s.lab.key === view.l) && (!view.m || s.modality === view.m));
    const W = narrow ? 360 : 560, H = 210, L = 38, R = 10, T = 12, B = 22;
    const t1 = d.generatedAt, t0 = t1 - d.days * DAY;
    const lo = -1, hi = Math.log10(Math.max(3000, ...d.sizes.map((s) => s.total)));
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (b) => T + (1 - (Math.log10(Math.max(0.1, b)) - lo) / (hi - lo)) * (H - T - B);
    const ticks = [0.1, 1, 10, 100, 1000].filter((v) => Math.log10(v) <= hi);
    // Labels for the biggest, skipping any that would collide with one placed.
    const placed = [];
    const top = new Set();
    for (const s of [...list].sort((a, b) => b.total - a.total)) {
      if (!s.name || top.size >= (narrow ? 3 : 5)) continue;
      const lx = x(s.at), ly = y(s.total);
      if (placed.some(([px, py]) => Math.abs(px - lx) < 110 && Math.abs(py - ly) < 14)) continue;
      placed.push([lx, ly]);
      top.add(s.id);
    }
    const dots = list.sort((a, b) => a.total - b.total).map((s, i) => {
      const cx = x(s.at), cy = y(s.total);
      const label = top.has(s.id) && s.name ? `<text class="ow-lab" x="${(cx + (cx > W - 130 ? -9 : 9)).toFixed(1)}" y="${cy.toFixed(1)}" dy="0.32em" text-anchor="${cx > W - 130 ? 'end' : 'start'}">${esc(s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name)}</text>` : '';
      return `<g class="ow-pt s${slot(s.lab.region)}" data-id="${esc(s.id)}" style="--i:${Math.min(i, 30)}">${s.active ? `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" y2="${y(s.active).toFixed(1)}"/><circle class="ow-act" cx="${cx.toFixed(1)}" cy="${y(s.active).toFixed(1)}" r="2.5"/>` : ''}<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5"/>${label}<circle class="ow-hit" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11"/></g>`;
    }).join('');
    const guides = [];
    const g = new Date(t0);
    g.setUTCDate(1);
    for (g.setUTCMonth(g.getUTCMonth() + 1); g.getTime() < t1; g.setUTCMonth(g.getUTCMonth() + 3)) guides.push(g.getTime());
    return `<section><h2 class="when">How big<span>parameters, log scale; a line drops to the active parameters of a mixture of experts</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(list.map((s) => `${s.name || s.lab.label}: ${params(s.total)}${s.active ? `, ${params(s.active)} active` : ''}`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${esc(params(v))}</text></g>`).join('')}
        ${guides.map((t) => `<text class="lc-xt" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(new Date(t).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }))}</text>`).join('')}
        ${dots}
      </svg></section>`;
  }

  function labs(d) {
    const rows = d.labs.slice(0, 14);
    const max = Math.max(1, ...rows.map((l) => l.n));
    return `<section class="ow-labs"><h2 class="when">Labs<span>open releases in a year; tap to filter</span></h2><ol>${rows.map((l, i) => {
      const on = view.l === l.key;
      return `<li style="--i:${i}"><a href="${esc(href({ l: on ? '' : l.key }))}" class="${on ? 'on' : ''}${view.l && !on ? ' dim' : ''}" data-l="${esc(l.key)}">
        <span class="ow-name">${esc(l.label)}</span><span class="ow-reg"><i class="ow-sw s${slot(l.region)}"></i>${esc(SHORT[l.region])}</span><span class="ow-bar s${slot(l.region)}" style="width:${((100 * l.n) / max).toFixed(1)}%"></span><small>${l.n}</small></a></li>`;
    }).join('')}</ol></section>`;
  }

  function builtOn(d) {
    if (!d.builtOn.length) return '';
    return `<section class="ow-built"><h2 class="when">Built on<span>other companies’ models made from a lab’s open weights</span></h2><ul>${d.builtOn.map((b) => `<li><p class="ow-base"><i class="ow-sw s${slot(b.region)}"></i><b>${esc(b.label)}</b><small>${plural(b.n, 'model')}</small></p>
      <p class="ow-kids">${b.builders.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.title)}">${esc(x.builder)}${x.name ? ` · ${esc(x.name)}` : ''}</a>`).join('')}</p></li>`).join('')}</ul></section>`;
  }

  function card(x, i) {
    const d = data.d;
    const size = [x.total && `${params(x.total)}${x.active ? ` total · ${params(x.active)} active` : ''}`, x.context && ctx(x.context), x.license !== 'unstated' && d.labels.licenses[x.license]].filter(Boolean);
    return `<li class="ow-card" id="ow-${esc(x.id)}" style="--i:${Math.min(i, 14)}">
      <details${view.e === x.id ? ' open' : ''}>
        <summary>
          <p class="ct-meta"><a class="tl-chip" href="${esc(href({ l: x.lab.key }))}"><i class="ow-sw s${slot(x.lab.region)}"></i>${esc(x.lab.label)}</a><span class="ow-mod">${esc(d.labels.modalities[x.modality])}</span></p>
          ${x.name ? `<h3 class="ow-model">${esc(x.name)}</h3>` : ''}
          <p class="ow-title">${esc(x.title)}</p>
          <p class="ct-sub">${size.length ? `<b class="ow-size">${esc(size.join(' · '))}</b> · ` : ''}${esc(dayFmt(x.at))} · ${plural(x.outlets, 'outlet')}</p>
        </summary>
        <ol class="ct-events">${x.reports.map((e) => `<li><p class="ct-ev-h">${esc(dayFmt(e.at))}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.releases.filter(matches);
    list.sort((a, b) => (b.id === view.e) - (a.id === view.e) || b.at - a.at);
    const s = d.stats;
    const change = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}% on the 90 days before` : 'none in the 90 days before');
    const cn = d.regions.find((r) => r.key === 'china');
    const labels = [view.r && d.labels.regions[view.r], view.l && (d.labs.find((l) => l.key === view.l)?.label || view.l), view.m && d.labels.modalities[view.m]].filter(Boolean);
    return `<div class="tl-stats">
        <p><b>${s.n90}</b><span>open model releases in the last 90 days (${esc(change(s.n90, s.prev90))})</span></p>
        <p><b>${Math.round(s.chinaShare90 * 100)}%</b><span>from Chinese labs in 90 days (${cn?.n90 || 0}), ${Math.round(s.usShare90 * 100)}% from American</span></p>
        ${s.biggest ? `<p><b>${esc(params(s.biggest.total))}</b><span>biggest: ${esc(s.biggest.name || s.biggest.lab.label)} (${esc(s.biggest.lab.label)})</span></p>` : ''}
        <p><b>${Math.round(s.moeShare * 100)}%</b><span>of releases with a size named are mixtures of experts${s.medianTotal90 ? `; median ${esc(params(s.medianTotal90))} in 90 days` : ''}</span></p>
      </div>
      <div class="ow-top">${columns(d, narrow)}${sizes(d, narrow)}</div>
      <div class="ow-grid">${labs(d)}${builtOn(d)}</div>
      <nav class="pd-chips ct-themes" aria-label="Kind of model"><a class="chip${view.m ? '' : ' on'}" href="${esc(href({ m: '' }))}">All</a>${d.modalities.filter((m) => m.n).map((m) => `<a class="chip${view.m === m.key ? ' on' : ''}" href="${esc(href({ m: view.m === m.key ? '' : m.key }))}">${esc(m.label)} <small>${m.n}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Releases')}<span>${list.length}, newest first${narrow && list.length > 30 ? ', 30 shown' : ''}</span>${labels.length ? '<a class="tl-clear" href="#open">Show all</a>' : ''}</h2>
        <ol class="ct-cases">${list.slice(0, narrow ? 30 : 80).map(card).join('') || '<li class="rail-note">No releases match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} headlines in English over the last year that name a lab releasing a model and say its weights are open, or name a family that ships open (Gemma, Qwen, Llama, Nemotron, GLM…). Tools, engines, datasets and hosted-only models are left out. The same lab’s model reported within a month is one release; sizes and licenses come from the headlines, so many are missing. A model another company post-trained or built on a lab’s weights is listed under Built on. Model specs are on <a href="#models">Compare models</a>. <a href="/api/open">JSON</a></p>
      <div class="ac-tip ow-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#openView');
    document.title = `Open weights · ${site}`;
    const head = `<header class="topic-head ow-head"><p class="kicker">Open weights</p><h1>The open model race</h1>
      <p class="topic-sum">Models anyone can download and run: who releases them, how big they are, what they’re for, and how the US and China compare.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Open weights need the live server.</p>`);
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
    setHtml(host, `${head}<div class="ow-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.e && scrolled !== view.e) {
      scrolled = view.e;
      // After the router's scroll to the top.
      requestAnimationFrame(() => document.getElementById(`ow-${view.e}`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
  }

  function hover(e) {
    const tip = $('#openView .ow-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.ow-col');
    const pt = t?.closest?.('.ow-pt');
    const lab = t?.closest?.('.ow-labs a');
    let html = '';
    let el = null;
    if (col) {
      const m = d.months[+col.dataset.m];
      el = col;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p><p><b>${plural(m.n, 'release')}</b></p>${REGIONS.map((r, s) => (m.regions[r] ? `<p><i class="sw" style="--c:var(--s${s + 1}c)"></i>${esc(d.labels.regions[r])}: <b>${m.regions[r]}</b></p>` : '')).join('')}`;
    } else if (pt) {
      const s = d.sizes.find((x) => x.id === pt.dataset.id);
      if (s) {
        el = pt.querySelector('circle:not(.ow-act):not(.ow-hit)');
        html = `<p class="tt-h">${esc(s.name || 'A model')} · ${esc(s.lab.label)}</p><p><b>${esc(params(s.total))}</b> parameters${s.active ? `, ${esc(params(s.active))} active` : ''}</p><p><small>${esc(dayFmt(s.at))} · ${esc(d.labels.modalities[s.modality])}</small></p>`;
      }
    } else if (lab) {
      const l = d.labs.find((x) => x.key === lab.dataset.l);
      if (l) {
        el = lab.querySelector('.ow-bar');
        html = `<p class="tt-h">${esc(l.label)}</p><p><b>${plural(l.n, 'release')}</b>, ${l.n90} in the last 90 days</p>${l.biggest ? `<p>Biggest: ${esc(l.biggest.name || '')} ${esc(params(l.biggest.total))}</p>` : ''}${Object.entries(l.modalities).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<p>${esc(d.labels.modalities[k])}: <b>${n}</b></p>`).join('')}`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#openView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
