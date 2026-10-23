// Shipped (#shipped?p=<product>&k=<kind>): a changelog for AI products.
// A heatmap of changes per product per week (tap a row to filter), product
// and kind chips, and the changelog grouped by week with each change's kind
// and every outlet that reported it. Server side: src/index/shipped.js.

const DAY = 86400e3;
const dayFmt = (t) => new Date(t).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function createShipped({ $, esc, setHtml, state, reducedMotion }) {
  const view = { p: '', k: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#shipped(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.p = (p.get('p') || '').replace(/[^a-z-]/g, '').slice(0, 20);
    view.k = (p.get('k') || '').replace(/[^a-z]/g, '').slice(0, 20);
    return 'shipped';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 15 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/shipped');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'shipped') render();
  }

  const href = (over = {}) => {
    const v = { ...view, ...over };
    const p = new URLSearchParams();
    for (const k of ['p', 'k']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#shipped${s ? `?${s}` : ''}`;
  };

  // Products by weeks; one hue, darker for more changes.
  function heatmap(d, narrow) {
    const weeks = d.products[0]?.weeks.length || 17;
    const max = Math.max(1, ...d.products.flatMap((p) => p.weeks));
    const steps = [0.14, 0.32, 0.55, 0.8, 1];
    const level = (n) => (n ? steps[Math.min(steps.length - 1, Math.floor((n / max) * steps.length - 1e-9))] : 0);
    const LW = narrow ? 98 : 140, CW = narrow ? 15 : 34, CH = 22, G = 3, T = 18;
    const W = LW + weeks * CW, H = T + d.products.length * (CH + G);
    const rows = d.products.map((p, ri) => {
      const on = view.p === p.key;
      const y = T + ri * (CH + G);
      return `<a href="${esc(href({ p: on ? '' : p.key }))}" class="sh-row${on ? ' on' : ''}${view.p && !on ? ' dim' : ''}">
        <text class="sh-rl" x="${LW - 8}" y="${y + CH / 2}" dy="0.32em" text-anchor="end">${esc(p.label)}</text>
        ${p.weeks.map((n, wi) => `<rect class="sh-cell${n ? '' : ' none'}" data-p="${p.key}" data-w="${wi}" x="${LW + wi * CW + 1}" y="${y}" width="${CW - 2}" height="${CH}" rx="3" style="--a:${level(n)};--i:${wi}"/>`).join('')}</a>`;
    }).join('');
    const label = (wi) => shortDay(d.weekStart + wi * 7 * DAY);
    return `<section class="sh-heat"><h2 class="when">Who ships most<span>changes per week, last ${weeks} weeks; tap a product</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.products.map((p) => `${p.label}: ${p.weeks.join(', ')}`).join('; '))}">
        ${[0, Math.floor(weeks / 2), weeks - 1].map((wi) => `<text class="lc-xt" x="${LW + wi * CW + CW / 2}" y="11" text-anchor="middle">${esc(wi === weeks - 1 ? 'this week' : label(wi))}</text>`).join('')}
        ${rows}
      </svg>
      <p class="sh-scale"><span>fewer</span>${steps.map((a) => `<i style="--a:${a}"></i>`).join('')}<span>more (up to ${max} a week)</span></p></section>`;
  }

  function changelog(d) {
    const list = d.entries.filter((x) => (!view.p || x.product === view.p) && (!view.k || x.kind === view.k));
    const now = d.generatedAt;
    let last = '';
    const rows = [];
    list.slice(0, 120).forEach((x, i) => {
      const age = Math.floor((now - x.at) / (7 * DAY));
      const h = age === 0 ? 'This week' : age === 1 ? 'Last week' : `Week of ${shortDay(now - (age + 1) * 7 * DAY + DAY)}`;
      if (h !== last) { rows.push(`<li class="sh-h"><h2 class="when">${esc(h)}</h2></li>`); last = h; }
      rows.push(`<li class="sh-item" style="--i:${Math.min(i, 20)}">
        <p class="sh-meta"><a class="sh-prod" href="${esc(href({ p: x.product }))}">${esc(d.labels.products[x.product])}</a><span class="sh-kind k-${x.kind}">${esc(d.labels.kinds[x.kind])}</span><time>${esc(dayFmt(x.at))}</time></p>
        <h3><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></h3>
        <p class="sh-src">${esc(x.source)}${x.reports.length > 1 ? ` · ${x.reports.slice(1, 4).map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source)}</a>`).join(', ')}` : ''}${x.outlets > 4 ? ` and ${x.outlets - 4} more` : ''}</p></li>`);
    });
    const labels = [view.p && d.labels.products[view.p], view.k && d.labels.kinds[view.k]].filter(Boolean);
    return `<section class="sh-log"><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Changelog')}<span>${list.length} changes in ${d.days} days, newest first</span>${labels.length ? '<a class="tl-clear" href="#shipped">Show all</a>' : ''}</h2><ol>${rows.join('') || '<li class="rail-note">Nothing shipped matches.</li>'}</ol></section>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const s = d.stats;
    return `<div class="tl-stats">
        <p><b>${s.week}</b><span>changes shipped in the last seven days across ${s.products} products</span></p>
        ${s.busiest ? `<p><b>${esc(s.busiest.label)}</b><span>shipped most in 30 days: ${plural(s.busiest.n30, 'change')}</span></p>` : ''}
        <p><b>${s.removals30}</b><span>removals and retirements in 30 days</span></p>
      </div>
      ${heatmap(d, narrow)}
      <nav class="pd-chips ct-themes" aria-label="Product"><a class="chip${view.p ? '' : ' on'}" href="${esc(href({ p: '' }))}">All products</a>${d.products.map((p) => `<a class="chip${view.p === p.key ? ' on' : ''}" href="${esc(href({ p: view.p === p.key ? '' : p.key }))}">${esc(p.label)} <small>${p.n}</small></a>`).join('')}</nav>
      <nav class="pd-chips ct-themes" aria-label="Kind of change"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '' }))}">Every kind</a>${d.kinds.filter((k) => k.n).map((k) => `<a class="chip${view.k === k.key ? ' on' : ''}" href="${esc(href({ k: view.k === k.key ? '' : k.key }))}">${esc(k.label)} <small>${k.n}</small></a>`).join('')}</nav>
      ${changelog(d)}
      <p class="rail-note">From ${d.headlines} headlines in ${d.days} days that open with an AI product or its maker shipping something (“Claude can now…”, “OpenAI rolls out … for ChatGPT”). Other companies building on a product, how-tos, reviews and comparisons are left out, and outlets reporting the same change within four days are one entry. A headline is not a release note, so check the source for details. New models in depth are on <a href="#releases">Releases</a>. <a href="/api/shipped">JSON</a></p>
      <div class="ac-tip sh-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#shippedView');
    document.title = `Shipped · ${site}`;
    const head = `<header class="topic-head sh-head"><p class="kicker">Shipped</p><h1>What AI products shipped</h1>
      <p class="topic-sum">A running changelog for ChatGPT, Claude, Gemini, Copilot, Grok and the rest: new features, models, prices, places, and what got taken away.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Shipped needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="sh-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  function hover(e) {
    const tip = $('#shippedView .sh-tip');
    const d = data.d;
    if (!tip || !d) return;
    const c = e.type === 'pointerleave' ? null : e.target?.closest?.('.sh-cell');
    const p = c && d.products.find((x) => x.key === c.dataset.p);
    if (!p) { tip.hidden = true; return; }
    const wi = +c.dataset.w;
    const from = d.weekStart + wi * 7 * DAY;
    const items = d.entries.filter((x) => x.product === p.key && x.at >= from && x.at < from + 7 * DAY).slice(0, 4);
    setHtml(tip, `<p class="tt-h">${esc(p.label)}, week of ${esc(shortDay(from))}</p><p><b>${plural(p.weeks[wi], 'change')}</b></p>${items.map((x) => `<p>${esc(x.title.length > 70 ? `${x.title.slice(0, 68)}…` : x.title)}</p>`).join('')}`);
    tip.hidden = false;
    const host = $('#shippedView').getBoundingClientRect();
    const r = c.getBoundingClientRect();
    const w = tip.offsetWidth || 220;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
