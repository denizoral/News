// AI words (#terms?k=<kind>&t=<term>): the jargon in AI news, explained.
// The fastest rising terms as cards with a year's sparkline, every term's
// change in share against the 90 days before as diverging bars, and the
// glossary by kind; opening a term shows its month-by-month share with hover
// and the latest headlines that use it. Server side: src/index/terms.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const monLong = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const pct = (g) => `${g >= 0 ? '+' : '−'}${Math.abs(Math.round(g * 100))}%`;
// Per 1,000 headlines reads better than tiny percentages.
const per1k = (s) => (s * 1000 >= 10 ? Math.round(s * 1000) : +(s * 1000).toFixed(1));

export function createTerms({ $, esc, setHtml, state, reducedMotion }) {
  const view = { k: '', t: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let scrolled = '';

  function route(hash) {
    const m = /^#terms(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.k = (p.get('k') || '').replace(/[^A-Za-z]/g, '').slice(0, 20);
    view.t = (p.get('t') || '').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    return 'terms';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/terms');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'terms') render();
  }

  const href = (over = {}) => {
    const v = { ...view, ...over };
    const p = new URLSearchParams();
    for (const k of ['k', 't']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#terms${s ? `?${s}` : ''}`;
  };

  function spark(t, W = 120, H = 32) {
    const max = Math.max(...t.series.map((s) => s.share)) || 1;
    const x = (i) => 2 + (i / (t.series.length - 1)) * (W - 4);
    const y = (v) => H - 3 - (v / max) * (H - 8);
    const pts = t.series.map((s, i) => `${x(i).toFixed(1)},${y(s.share).toFixed(1)}`).join(' ');
    const last = t.series.at(-1);
    return `<svg class="tm-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}"/><circle cx="${x(t.series.length - 1).toFixed(1)}" cy="${y(last.share).toFixed(1)}" r="2.5"/></svg>`;
  }

  function rising(d) {
    const list = d.rising.map((k) => d.terms.find((t) => t.key === k)).filter(Boolean);
    if (!list.length) return '';
    return `<section class="tm-rise"><h2 class="when">Rising<span>the biggest gains in share of headlines, last 90 days against the 90 before</span></h2>
      <ol>${list.map((t, i) => `<li style="--i:${i}"><a href="${esc(href({ t: t.key, k: '' }))}" class="tm-rc">
        <p class="tm-rh"><b>${esc(t.term)}</b><span class="tm-g up">${esc(pct(t.growth))}</span></p>
        ${spark(t)}
        <p class="tm-rd">${esc(t.def)}</p></a></li>`).join('')}</ol></section>`;
  }

  // Change in share for every term with enough history, rising above the
  // line on one side and fading on the other, one scale.
  function change(d, narrow) {
    const list = d.terms.filter((t) => t.growth != null && t.n90 >= 5).sort((a, b) => b.growth - a.growth);
    if (!list.length) return '';
    const cap = 2;
    const W = narrow ? 360 : 560, LW = narrow ? 112 : 150, R = 44, RH = 18, T = 4;
    const H = T + list.length * RH + 4;
    const mid = LW + (W - LW - R) * (1 / 3);
    const k = (W - LW - R - (mid - LW)) / cap;
    const rows = list.map((t, i) => {
      const g = Math.max(-1, Math.min(cap, t.growth));
      const w = Math.abs(g) * k;
      const y = T + i * RH;
      const up = g >= 0;
      return `<a href="${esc(href({ t: t.key, k: '' }))}" class="tm-row" data-t="${esc(t.key)}" style="--i:${i}">
        <text x="${LW - 8}" y="${y + RH / 2}" dy="0.32em" text-anchor="end" class="tm-rl">${esc(t.term)}</text>
        <rect class="${up ? 'tm-up' : 'tm-down'}" x="${(up ? mid : mid - w).toFixed(1)}" y="${y + 3}" width="${Math.max(1.5, w).toFixed(1)}" height="${RH - 6}" rx="2"/>
        <text x="${(up ? mid + w + 4 : mid + 4).toFixed(1)}" y="${y + RH / 2}" dy="0.32em" class="tm-rv">${esc(pct(t.growth))}${t.growth > cap ? ' ›' : ''}</text>
        <rect class="tm-hit" x="0" y="${y}" width="${W}" height="${RH}"/></a>`;
    }).join('');
    return `<section class="tm-change"><h2 class="when">Rising and fading<span>change in share of headlines, last 90 days against the 90 before; tap a term</span></h2>
      <ul class="tr-legend"><li style="--c:var(--tm-up)"><i class="sw"></i>Used more</li><li style="--c:var(--tm-down)"><i class="sw"></i>Used less</li></ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(list.map((t) => `${t.term}: ${pct(t.growth)}`).join('; '))}">
        <line class="tm-mid" x1="${mid}" x2="${mid}" y1="0" y2="${H}"/>${rows}
      </svg></section>`;
  }

  // One term's year: columns of share per 1,000 headlines.
  function detail(t, d, narrow) {
    const W = narrow ? 320 : 520, H = 150, L = 30, R = 4, T = 10, B = 20;
    const max = Math.max(...t.series.map((s) => s.share)) || 1;
    const bw = (W - L - R) / t.series.length;
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const cols = t.series.map((s, i) => `<g class="tm-col" data-t="${esc(t.key)}" data-m="${i}" style="--i:${i}">${s.n ? `<rect x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${y(s.share).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, H - B - y(s.share)).toFixed(1)}" rx="2"/>` : ''}<rect class="tm-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
      ${i % (narrow ? 3 : 2) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(monFmt(s.m))}</text>` : ''}`).join('');
    return `<div class="tm-detail">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.series.map((s) => `${monLong(s.m)}: ${s.n} headlines`).join('; '))}">
        <g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(max).toFixed(1)}" y2="${y(max).toFixed(1)}"/><text x="${L - 6}" y="${y(max).toFixed(1)}" dy="0.32em" text-anchor="end">${per1k(max)}</text></g>
        <g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/><text x="${L - 6}" y="${H - B}" dy="0.32em" text-anchor="end">0</text></g>
        ${cols}
      </svg>
      <p class="tm-unit">headlines per 1,000 stored that month${t.peak ? ` · peak ${esc(monLong(t.peak))}` : ''}</p>
      ${t.examples.length ? `<ol class="tm-ex">${t.examples.map((e) => `<li><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a><small>${esc(e.source || '')} · ${esc(dayFmt(e.at))}</small></li>`).join('')}</ol>` : ''}
    </div>`;
  }

  function entry(t, d, narrow, i) {
    const open = view.t === t.key;
    return `<li class="tm-entry" id="term-${esc(t.key)}" style="--i:${Math.min(i, 20)}">
      <details${open ? ' open' : ''} data-t="${esc(t.key)}">
        <summary>
          <div class="tm-eh"><h3>${esc(t.term)}</h3><span class="tm-kind">${esc(t.kind)}</span></div>
          <p class="tm-def">${esc(t.def)}</p>
          <div class="tm-meta">${spark(t, 96, 26)}<span><b>${t.n90.toLocaleString('en')}</b> headlines in 90 days</span>${t.growth != null ? `<span class="tm-g ${t.growth >= 0 ? 'up' : 'down'}">${esc(pct(t.growth))}</span>` : t.n90 ? '<span class="tm-g">new</span>' : ''}</div>
        </summary>
        ${detail(t, d, narrow)}
      </details></li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.terms.filter((t) => !view.k || t.kind === view.k).sort((a, b) => (b.key === view.t) - (a.key === view.t) || a.term.localeCompare(b.term));
    return `${rising(d)}
      ${change(d, narrow)}
      <nav class="pd-chips ct-themes" aria-label="Kind"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '', t: '' }))}">All <small>${d.terms.length}</small></a>${d.kinds.map((k) => `<a class="chip${view.k === k ? ' on' : ''}" href="${esc(href({ k: view.k === k ? '' : k, t: '' }))}">${esc(k)} <small>${d.terms.filter((t) => t.kind === k).length}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc(view.k || 'The glossary')}<span>A to Z; open a term for its year and the latest headlines</span></h2>
        <ol class="tm-list">${list.map((t, i) => entry(t, d, narrow, i)).join('')}</ol></section>
      <p class="rail-note">A term’s share is the headlines using it out of all ${d.stats.headlines90.toLocaleString('en')} stored in the last 90 days (and the same for each month), so a busier crawl doesn’t make a word look like it’s rising. Words that also mean other things (agents, tokens, inference, alignment) count only next to an AI word. Growth is left out while a term had fewer than five headlines in the 90 days before. Names of companies and products are on <a href="#new">New names</a>. <a href="/api/terms">JSON</a></p>
      <div class="ac-tip tm-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#termsView');
    document.title = `AI words · ${site}`;
    const head = `<header class="topic-head tm-head"><p class="kicker">AI words</p><h1>The words of AI, explained</h1>
      <p class="topic-sum">Agents, MCP, mixture of experts, alignment, slop: what the jargon in the news means, and which words are taking over the headlines.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">AI words need the live server.</p>`);
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
    setHtml(host, `${head}<div class="tm-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.t && scrolled !== view.t) {
      scrolled = view.t;
      // After the router's scroll to the top.
      requestAnimationFrame(() => document.getElementById(`term-${view.t}`)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
  }

  function hover(e) {
    const tip = $('#termsView .tm-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const row = t?.closest?.('.tm-row');
    const col = t?.closest?.('.tm-col');
    let html = '';
    let el = null;
    if (row) {
      const x = d.terms.find((k) => k.key === row.dataset.t);
      if (x) {
        el = row.querySelector('rect:not(.tm-hit)');
        html = `<p class="tt-h">${esc(x.term)} ${esc(pct(x.growth))}</p><p>${per1k(x.share90)} per 1,000 headlines in the last 90 days, ${per1k(x.sharePrev)} in the 90 before</p><p><small>${x.n90.toLocaleString('en')} headlines</small></p>`;
      }
    } else if (col) {
      const x = d.terms.find((k) => k.key === col.dataset.t);
      const s = x?.series[+col.dataset.m];
      if (s) {
        el = col;
        html = `<p class="tt-h">${esc(x.term)}, ${esc(monLong(s.m))}</p><p><b>${s.n.toLocaleString('en')}</b> headlines, ${per1k(s.share)} per 1,000</p>`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#termsView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
