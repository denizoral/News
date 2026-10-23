// AI by the numbers (#numbers?c=<company>&m=<metric>): the figures put on AI
// companies. One panel per metric with each company's latest figure as a bar
// (hollow when the latest is only an outlook) and its history as a small dot
// chart beside it, then every figure with its headline. Company names open
// their dossier. Server side: src/index/numbers.js.

const DAY = 86400e3;
const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const fmt = (x) => {
  const v = x.value;
  if (x.unit === 'people') return v >= 1e9 ? `${+(v / 1e9).toPrecision(3)}B` : `${+(v / 1e6).toPrecision(3)}M`;
  return v >= 1e12 ? `$${+(v / 1e12).toPrecision(3)}T` : v >= 1e9 ? `$${+(v / 1e9).toPrecision(3)}B` : `$${Math.round(v / 1e6)}M`;
};
const DOSSIER = new Set(['openai', 'anthropic', 'google', 'meta', 'microsoft', 'xai', 'nvidia', 'amazon', 'apple', 'deepseek', 'mistral']);

export function createNumbers({ $, esc, setHtml, state, reducedMotion }) {
  const view = { c: '', m: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#numbers(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.c = (p.get('c') || '').replace(/[^a-z]/g, '').slice(0, 20);
    view.m = (p.get('m') || '').replace(/[^a-z]/g, '').slice(0, 20);
    return 'numbers';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/numbers');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'numbers') render();
  }

  const href = (over = {}) => {
    const v = { ...view, ...over };
    const p = new URLSearchParams();
    for (const k of ['c', 'm']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#numbers${s ? `?${s}` : ''}`;
  };
  const coLink = (key, label) => (DOSSIER.has(key) ? `<a href="#co/${esc(key)}">${esc(label)}</a>` : esc(label));

  // A company's figures for one metric over the year, on that metric's scale.
  function history(row, max, d) {
    const W = 120, H = 28, P = 4;
    const t0 = d.generatedAt - d.days * DAY;
    const x = (t) => P + ((t - t0) / (d.generatedAt - t0)) * (W - 2 * P);
    const y = (v) => H - P - (v / max) * (H - 2 * P);
    const pts = row.history;
    const line = pts.filter((p) => !p.outlook).map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    return `<svg class="nb-hist" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line class="nb-base" x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}"/>${line ? `<polyline points="${line}"/>` : ''}${pts.map((p) => `<circle class="${p.outlook ? 'out' : ''}" cx="${x(p.at).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.6"/>`).join('')}</svg>`;
  }

  function panel(b, d, i) {
    const rows = b.companies.filter((r) => !view.c || r.company === view.c);
    if (!rows.length) return '';
    const max = Math.max(...b.companies.map((r) => Math.max(r.latest.value, ...r.history.map((p) => p.value))));
    return `<section class="nb-panel" style="--i:${i}"><h2 class="when">${esc(b.label)}<span>latest figure per company; the dots are its history this year</span></h2><ol>${rows.map((r, j) => {
      const l = r.latest;
      return `<li style="--i:${j}">
        <span class="nb-co">${coLink(r.company, r.label)}</span>
        <span class="nb-barw"><span class="nb-bar${l.outlook ? ' out' : ''}" style="width:${Math.max(1.5, (100 * l.value) / max).toFixed(1)}%"></span></span>
        <span class="nb-v"><b>${esc(fmt(l))}</b>${l.period ? `<small>${esc(l.period)}</small>` : ''}${l.outlook ? '<small class="nb-tag">outlook</small>' : ''}${l.part ? '<small class="nb-tag" title="For part of the business, not the whole company">part</small>' : ''}${l.reported ? '<small class="nb-tag">reportedly</small>' : ''}</span>
        ${history(r, max, d)}
        <a class="nb-src" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.title)}">${esc(l.source || 'source')}</a></li>`;
    }).join('')}</ol></section>`;
  }

  function list(d) {
    const pts = d.points.filter((p) => (!view.c || p.company === view.c) && (!view.m || p.metric === view.m)).slice(0, 60);
    const labels = [view.c && d.labels.companies[view.c], view.m && d.labels.metrics[view.m]].filter(Boolean);
    return `<section class="nb-list"><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Every figure')}<span>newest first</span>${labels.length ? '<a class="tl-clear" href="#numbers">Show all</a>' : ''}</h2><ol>${pts.map((p, i) => `<li style="--i:${Math.min(i, 20)}">
      <b class="nb-amt">${esc(fmt(p))}</b>
      <div><p class="nb-meta">${coLink(p.company, d.labels.companies[p.company])} · ${esc(d.labels.metrics[p.metric])}${p.period ? ` · ${esc(p.period)}` : ''}${p.outlook ? ' · <span class="nb-tag">outlook</span>' : ''}${p.part ? ' · <span class="nb-tag">part of the business</span>' : ''}${p.reported ? ' · <span class="nb-tag">reportedly</span>' : ''}</p>
      <p class="nb-t"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><small>${esc(p.source)}${p.outlets > 1 ? ` and ${p.outlets - 1} more` : ''} · ${esc(dayFmt(p.at))}</small></p></div></li>`).join('') || '<li class="rail-note">No figures match.</li>'}</ol></section>`;
  }

  function page(d) {
    const s = d.stats;
    const panels = d.board.filter((b) => !view.m || b.metric === view.m);
    return `<div class="tl-stats">
        <p><b>${s.n30}</b><span>figures reported in the last 30 days, ${s.points} in a year</span></p>
        ${s.topRunrate ? `<p><b>${esc(fmt(s.topRunrate.latest))}</b><span>biggest run rate named: ${esc(s.topRunrate.label)}</span></p>` : ''}
        ${s.topUsers ? `<p><b>${esc(fmt(s.topUsers.latest))}</b><span>biggest user count: ${esc(s.topUsers.label)}${s.topUsers.latest.period ? ` (${esc(s.topUsers.latest.period)})` : ''}</span></p>` : ''}
        <p><b>${s.companies}</b><span>companies with figures</span></p>
      </div>
      <nav class="pd-chips ct-themes" aria-label="Metric"><a class="chip${view.m ? '' : ' on'}" href="${esc(href({ m: '' }))}">Every metric</a>${d.board.map((b) => `<a class="chip${view.m === b.metric ? ' on' : ''}" href="${esc(href({ m: view.m === b.metric ? '' : b.metric }))}">${esc(b.label)}</a>`).join('')}</nav>
      <nav class="pd-chips ct-themes" aria-label="Company"><a class="chip${view.c ? '' : ' on'}" href="${esc(href({ c: '' }))}">Every company</a>${d.companies.map((c) => `<a class="chip${view.c === c.key ? ' on' : ''}" href="${esc(href({ c: view.c === c.key ? '' : c.key }))}">${esc(c.label)} <small>${c.n}</small></a>`).join('')}</nav>
      <div class="nb-panels">${panels.map((b, i) => panel(b, d, i)).join('')}</div>
      ${list(d)}
      <p class="rail-note">From ${d.headlines} headlines in the last year that open with a company and put a figure on it: run-rate revenue, reported revenue, losses and burn, spending on compute and data centers, or users. The amount is the one nearest the metric’s word; valuations, bond sales, IPO targets and gaps (“$20 billion lower”) are left out. Forecasts are marked outlook and hollow, figures for one product or unit (an ad business, Claude Code, Azure) “part”, and secondhand reports “reportedly”; a company’s bar shows its latest whole-company figure when there is one. Headlines round and companies define revenue differently, so compare with care. Valuations are on <a href="#deals">Deals</a>. <a href="/api/numbers">JSON</a></p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#numbersView');
    document.title = `AI by the numbers · ${site}`;
    const head = `<header class="topic-head nb-head"><p class="kicker">Numbers</p><h1>AI by the numbers</h1>
      <p class="topic-sum">Revenue, run rates, losses, spending on compute and users: the figures put on AI companies, how they’ve changed, and where each came from.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The numbers need the live server.</p>`);
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
    setHtml(host, `${head}<div class="nb-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  return { route, render };
}
