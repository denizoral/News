// Talent moves (#talent?org=<key>): who joined, left or was hired away
// between AI labs and big tech. A flow diagram from where people left to
// where they went, each company's arrivals and departures as a diverging
// bar, and the moves themselves (filter by company). Server side:
// src/index/talent.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const KIND = { join: 'Joined', hire: 'Hired', leave: 'Left', appoint: 'Appointed' };

export function createTalent({ $, esc, setHtml, state, reducedMotion }) {
  const view = { org: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#talent(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.org = (new URLSearchParams(m[1] || '').get('org') || '').replace(/[^a-z0-9-]/g, '');
    return 'talent';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/talent');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'talent') render();
  }

  const href = (org) => `#talent${org ? `?org=${org}` : ''}`;

  // Left: where people left from; right: where they went. Ribbon width by
  // number of moves; a company can sit on both sides.
  function flows(d, narrow) {
    const f = d.flows;
    if (f.length < 2) return '';
    const W = narrow ? 360 : 760, rowH = narrow ? 30 : 34, unit = narrow ? 8 : 10, LW = narrow ? 92 : 140;
    const tot = (k, side) => f.filter((x) => x[side] === k).reduce((s, x) => s + x.n, 0);
    const lefts = [...new Set(f.map((x) => x.from))].sort((a, b) => tot(b, 'from') - tot(a, 'from'));
    const rights = [...new Set(f.map((x) => x.to))].sort((a, b) => tot(b, 'to') - tot(a, 'to'));
    const H = Math.max(lefts.length, rights.length) * rowH + 16;
    const ly = new Map(lefts.map((k, i) => [k, 10 + i * rowH + rowH / 2]));
    const ry = new Map(rights.map((k, i) => [k, 10 + i * rowH + rowH / 2]));
    const x0 = LW + 8, x1 = W - LW - 8;
    // Stack ribbons at each end so they don't overlap.
    const lOff = new Map(), rOff = new Map();
    const ribbons = [...f].sort((a, b) => (ly.get(a.from) - ly.get(b.from)) || (ry.get(a.to) - ry.get(b.to))).map((x, i) => {
      const w = Math.max(2, x.n * unit * 0.6);
      const lo = lOff.get(x.from) || 0, ro = rOff.get(x.to) || 0;
      lOff.set(x.from, lo + w); rOff.set(x.to, ro + w);
      const a = ly.get(x.from) - tot(x.from, 'from') * unit * 0.3 + lo + w / 2;
      const b = ry.get(x.to) - tot(x.to, 'to') * unit * 0.3 + ro + w / 2;
      const on = !view.org || view.org === x.from || view.org === x.to;
      return `<path class="tl-ribbon${on ? '' : ' off'}" d="M${x0} ${a.toFixed(1)} C${(x0 + x1) / 2} ${a.toFixed(1)} ${(x0 + x1) / 2} ${b.toFixed(1)} ${x1} ${b.toFixed(1)}" style="--w:${w.toFixed(1)}px;--i:${i}"><title>${esc(`${x.fromLabel} → ${x.toLabel}: ${x.n} ${x.n === 1 ? 'person' : 'people'}`)}</title></path>`;
    });
    const label = (k, y, side, lab, n) => `<a href="${esc(href(view.org === k ? '' : k))}" class="tl-node${view.org === k ? ' on' : ''}"><text x="${side === 'l' ? LW : W - LW}" y="${y.toFixed(1)}" dy="0.32em" text-anchor="${side === 'l' ? 'end' : 'start'}">${esc(lab)} <tspan class="tl-n">${n}</tspan></text></a>`;
    const lab = (k) => (f.find((x) => x.from === k)?.fromLabel || f.find((x) => x.to === k)?.toLabel || k);
    return `<section class="tl-flows"><h2 class="when">Where people went<span>moves between companies, the last year</span></h2>
      <div class="tl-sides" aria-hidden="true"><span>Left</span><span>Joined</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(f.map((x) => `${x.fromLabel} to ${x.toLabel}: ${x.n}`).join('; '))}">
        ${ribbons.join('')}
        ${lefts.map((k) => label(k, ly.get(k), 'l', lab(k), tot(k, 'from'))).join('')}
        ${rights.map((k) => label(k, ry.get(k), 'r', lab(k), tot(k, 'to'))).join('')}
      </svg></section>`;
  }

  // Arrivals right, departures left, from one zero line.
  function balance(d) {
    const orgs = d.orgs.filter((o) => o.arrivals + o.departures > 0).slice(0, 14);
    if (!orgs.length) return '';
    const max = Math.max(...orgs.map((o) => Math.max(o.arrivals, o.departures)), 1);
    return `<section class="tl-balance"><h2 class="when">Arrivals and departures<span>tap a company to see its moves</span></h2>
      <ul class="tr-legend"><li style="--c:var(--s2c)"><i class="sw"></i>Left</li><li style="--c:var(--s1c)"><i class="sw"></i>Joined</li></ul>
      <ol class="tl-bars">${orgs.map((o, i) => `<li style="--i:${i}" class="${view.org && view.org !== o.key ? 'off' : ''}"><a href="${esc(href(view.org === o.key ? '' : o.key))}" title="${esc(`${o.label}: ${o.arrivals} joined, ${o.departures} left`)}">
        <span class="tl-org">${esc(o.label)}</span>
        <span class="tl-out"><i style="--w:${((o.departures / max) * 100).toFixed(1)}%"></i>${o.departures ? `<b>${o.departures}</b>` : ''}</span>
        <span class="tl-in"><i style="--w:${((o.arrivals / max) * 100).toFixed(1)}%"></i>${o.arrivals ? `<b>${o.arrivals}</b>` : ''}</span>
        <span class="tl-net ${o.net > 0 ? 'up' : o.net < 0 ? 'down' : ''}">${o.net > 0 ? '+' : ''}${o.net}</span>
      </a></li>`).join('')}</ol></section>`;
  }

  function move(m, i) {
    const org = (k, l) => (k ? `<a class="tl-chip" href="${esc(href(k))}">${esc(l)}</a>` : '<span class="tl-chip none">—</span>');
    return `<li class="tl-move" style="--i:${Math.min(i, 14)}">
      <p class="tl-when">${esc(dayFmt(m.at))} · <span class="tl-kind ${m.kind}">${KIND[m.kind]}</span>${m.outlets > 1 ? ` · ${m.outlets} outlets` : ''}</p>
      <h3>${esc((m.name || m.who).replace(/^./, (c) => c.toUpperCase()))}${m.name && m.role ? `<small>${esc(m.role)}</small>` : ''}</h3>
      <p class="tl-path">${org(m.from, m.fromLabel)}<span class="tl-arrow" aria-label="to">→</span>${org(m.to, m.toLabel || (m.kind === 'leave' ? 'next move not reported' : ''))}</p>
      <p class="tl-src"><img src="${esc(fav(hostOf(m.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a></p>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.moves.filter((m) => !view.org || m.from === view.org || m.to === view.org);
    const sel = d.orgs.find((o) => o.key === view.org);
    const gain = [...d.orgs].sort((a, b) => b.net - a.net)[0];
    const lose = [...d.orgs].sort((a, b) => a.net - b.net)[0];
    return `<div class="tl-stats">
        <p><b>${d.total}</b><span>moves in the last year</span></p>
        ${gain && gain.net > 0 ? `<p><b>${esc(gain.label)}</b><span>gained the most (+${gain.net})</span></p>` : ''}
        ${lose && lose.net < 0 ? `<p><b>${esc(lose.label)}</b><span>lost the most (${lose.net})</span></p>` : ''}
      </div>
      <div class="tl-grid">
        <div>${flows(d, narrow)}${balance(d)}</div>
        <section class="tl-list-wrap"><h2 class="when">${sel ? `${esc(sel.label)}’s moves` : 'Latest moves'}<span>${list.length}</span>${sel ? `<a class="tl-clear" href="#talent">Show all</a>` : ''}</h2>
          <ol class="tl-list${drawn ? '' : ''}">${list.slice(0, 80).map(move).join('') || '<li class="rail-note">No moves for this company.</li>'}</ol>
        </section>
      </div>
      <p class="rail-note">From headlines: someone joins, is hired or poached, or leaves a lab or big tech company. Internal promotions count as appointments, not arrivals. <a href="/api/talent">JSON</a></p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#talentView');
    document.title = `Talent moves · ${site}`;
    const head = `<header class="topic-head tl-head"><p class="kicker">Talent moves</p><h1>Who’s moving where</h1>
      <p class="topic-sum">Researchers and executives joining, leaving and being hired away across AI labs and big tech.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Talent moves need the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:320px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const key = `${d.generatedAt}:${view.org}`;
    const animate = drawn !== key && !reducedMotion() && !drawn?.startsWith(`${d.generatedAt}:`);
    drawn = key;
    setHtml(host, `${head}<div class="tl-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  return { route, render };
}
