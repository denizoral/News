// Rumor mill (#rumors): what was reported before it was announced, and
// whether it came true. Tallies by outcome (they filter the list), how far
// ahead of the announcement the true ones ran, which outlets' scoops hold up,
// and every claim on a small timeline from first report to settlement.
// Server side: src/index/rumors.js.

const DAY = 86400e3;
const STATUSES = [
  ['', 'All'],
  ['open', 'Still open'],
  ['confirmed', 'Came true'],
  ['denied', 'Denied'],
  ['quiet', 'Went quiet'],
];
const LABEL = { open: 'Still open', confirmed: 'Came true', denied: 'Denied', quiet: 'Went quiet' };
// Icons carry the outcome alongside the colour.
const ICON = {
  confirmed: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 11.6 3 8.2l1.2-1.2 2.2 2.2 5.4-5.4L13 5z"/></svg>',
  denied: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.2 3 3.8 3.8L11.8 3 13 4.2 9.2 8l3.8 3.8-1.2 1.2L8 9.2 4.2 13 3 11.8 6.8 8 3 4.2z"/></svg>',
  open: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4"/></svg>',
  quiet: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 7.2h10v1.6H3z"/></svg>',
};
const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const pct = (v) => `${Math.round(v * 100)}%`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ahead = (d) => (d == null ? '' : d < 1 ? 'the same day' : d < 1.5 ? '1 day later' : `${Math.round(d)} days later`);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;

export function createRumors({ $, esc, setHtml, state, reducedMotion }) {
  const view = { status: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let shown = 40;

  function route(hash) {
    const m = /^#rumors(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const s = new URLSearchParams(m[1] || '').get('status') || '';
    if (s !== view.status) shown = 40;
    view.status = STATUSES.some(([k]) => k === s) ? s : '';
    return 'rumors';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 10 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/rumors');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'rumors') render();
  }

  const href = (status) => `#rumors${status ? `?status=${status}` : ''}`;

  // The four outcomes as tiles; each one filters the list.
  function tallies(t) {
    const tiles = [['confirmed', t.confirmed], ['denied', t.denied], ['open', t.open], ['quiet', t.quiet]];
    return `<nav class="rm-tiles" aria-label="Outcomes">${tiles.map(([k, n], i) => `<a class="rm-tile ${k}${view.status === k ? ' on' : ''}" href="${esc(href(view.status === k ? '' : k))}" style="--i:${i}" aria-current="${view.status === k ? 'true' : 'false'}">
        <span class="rm-ic ${k}">${ICON[k]}</span><b>${n}</b><span>${LABEL[k]}</span>
      </a>`).join('')}</nav>
      <p class="rm-summary">${t.rate == null ? '' : `Of the ${t.confirmed + t.denied + t.quiet} rumors that have played out, <b>${pct(t.rate)}</b> came true`}${t.medianLead != null ? `, usually <b>${ahead(t.medianLead).replace(' later', '')}</b> before the announcement` : ''}${t.rate == null ? '' : '.'} The rest were denied or never followed up.</p>`;
  }

  // How far ahead of the announcement true rumors ran: one bar per range.
  function headStart(d) {
    const max = Math.max(1, ...d.ahead.map((b) => b.n));
    if (!d.totals.confirmed) return '';
    return `<section class="topic-card rm-ahead"><h2>How far ahead<small>rumors that came true, by time to the announcement</small></h2>
      <ol class="rm-hist">${d.ahead.map((b, i) => `<li style="--i:${i}" title="${esc(`${b.label}: ${plural(b.n, 'rumor')}`)}"><span class="rm-hl">${esc(b.label)}</span><span class="rm-track"><i style="--w:${((b.n / max) * 100).toFixed(1)}%"></i></span><b>${b.n}</b></li>`).join('')}</ol></section>`;
  }

  // Outlets' track record: one stacked bar per outlet (came true | denied |
  // went quiet), widths by share of that outlet's settled claims.
  function record(d) {
    if (!d.outlets.length) return '';
    const seg = (o, k) => (o[k] ? `<i class="${k}" style="--w:${((o[k] / o.claims) * 100).toFixed(1)}%"></i>` : '');
    return `<section class="topic-card rm-record"><h2>Whose rumors hold up<small>outlets with 3+ rumors that played out</small></h2>
      <ul class="tr-legend rm-legend"><li class="confirmed"><span class="rm-ic confirmed">${ICON.confirmed}</span>Came true</li><li class="denied"><span class="rm-ic denied">${ICON.denied}</span>Denied</li><li class="quiet"><span class="rm-ic quiet">${ICON.quiet}</span>Went quiet</li></ul>
      <ul class="rm-outlets">${[...d.outlets].sort((a, b) => b.rate - a.rate || b.claims - a.claims).map((o, i) => `<li style="--i:${i}" title="${esc(`${o.name}: ${o.confirmed} came true, ${o.denied} denied, ${o.quiet} went quiet${o.medianLead != null ? `; usually ${ahead(o.medianLead).replace(' later', '')} early` : ''}`)}">
          <span class="rm-on">${esc(o.name)}</span>
          <span class="rm-stack">${seg(o, 'confirmed')}${seg(o, 'denied')}${seg(o, 'quiet')}</span>
          <span class="rm-rate"><b>${o.confirmed}</b> of ${o.claims}</span>
        </li>`).join('')}</ul></section>`;
  }

  // One claim: the rumor, who carried it, and a track from first report to
  // whatever settled it (or to today, for an open one).
  function claim(c, i, now) {
    const end = c.settled ? c.settled.at : c.status === 'open' ? now : c.last;
    const span = Math.max(DAY, end - c.at);
    const others = c.sources.filter((s) => s !== c.source);
    return `<li class="rm-claim ${c.status}" style="--i:${Math.min(i, 12)}">
      <p class="rm-meta"><span class="rm-pill ${c.status}"><span class="rm-ic ${c.status}">${ICON[c.status]}</span>${LABEL[c.status]}</span>
        ${c.names.slice(0, 3).map((n) => `<a class="rm-name" href="#graph/${esc(n.key)}">${esc(n.label)}</a>`).join('')}</p>
      <h3><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a></h3>
      <p class="rm-src"><img src="${esc(fav(hostOf(c.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(c.source)} · ${esc(dayFmt(c.at))}${others.length ? ` · then ${esc(others.slice(0, 3).join(', '))}${others.length > 3 ? ` and ${others.length - 3} more` : ''}` : ''}</p>
      <div class="rm-line" role="img" aria-label="${esc(c.settled ? `${LABEL[c.status]} ${ahead(c.leadDays)}` : c.status === 'open' ? `Open for ${Math.round((now - c.at) / DAY)} days` : 'No follow-up')}">
        <i class="rm-a"></i><span class="rm-run" style="--w:${Math.min(100, 8 + (Math.log1p(span / DAY) / Math.log1p(90)) * 92).toFixed(1)}%"></span><i class="rm-b"></i>
        <small>${c.settled ? esc(ahead(c.leadDays)) : c.status === 'open' ? `open for ${plural(Math.max(1, Math.round((now - c.at) / DAY)), 'day')}` : `nothing since ${esc(dayFmt(c.last))}`}</small>
      </div>
      ${c.settled ? `<p class="rm-settle"><a href="${esc(c.settled.url)}" target="_blank" rel="noopener">${esc(c.settled.title)}</a><small>${esc(c.settled.source)} · ${esc(dayFmt(c.settled.at))}</small></p>` : ''}
    </li>`;
  }

  function page(d, animate) {
    const list = d.claims.filter((c) => !view.status || c.status === view.status);
    const now = d.generatedAt;
    return `${tallies(d.totals)}
      <div class="rm-grid">
        <section class="rm-list-wrap" aria-label="Rumors">
          <nav class="pd-chips" aria-label="Show">${STATUSES.map(([k, l]) => `<a class="chip${view.status === k ? ' on' : ''}" href="${esc(href(k))}">${l}<small>${k ? d.totals[k] : d.totals.claims}</small></a>`).join('')}</nav>
          ${list.length ? `<ol class="rm-list${animate ? ' animate' : ''}">${list.slice(0, shown).map((c, i) => claim(c, i, now)).join('')}</ol>` : '<p class="rail-note">Nothing here right now.</p>'}
          ${list.length > shown ? `<button class="chip rm-more" type="button" data-act="more">Show ${Math.min(40, list.length - shown)} more</button>` : ''}
        </section>
        <aside class="rm-side">${headStart(d)}${record(d)}
          <p class="rail-note rm-how">A rumor is a hedged headline (“reportedly”, “in talks”, “sources say”) about a lab, company or person. Later coverage that says the same thing without the hedge settles it; nothing for three weeks and it went quiet. <a href="/api/rumors">JSON</a></p>
        </aside>
      </div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#rumorsView');
    document.title = `Rumor mill · ${site}`;
    const head = `<header class="topic-head rm-head"><p class="kicker">Rumor mill</p><h1>Reported first, announced later?</h1>
      <p class="topic-sum">Every rumor about AI labs and companies in the last 90 days, and whether it came true.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The rumor mill needs the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:96px;display:block;margin:16px 0;border-radius:12px"></i><i class="skeleton" style="height:320px;display:block;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== d && !reducedMotion();
    drawn = d;
    setHtml(host, `${head}<div class="rm-page${animate ? ' animate' : ''}">${page(d, animate)}</div>`);
  }

  function onClick(e) {
    if (e.target.closest('[data-act="more"]')) {
      shown += 40;
      render();
    }
  }

  return { route, render, onClick };
}
