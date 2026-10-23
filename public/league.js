// The AI league table (#league?s=<column>): the big labs ranked by their
// share of the news this week, with movement from last week, a 14-day line
// of their daily share, their share of X posts, the mood of their headlines,
// what they shipped and Polymarket's odds of the best model at year end.
// Each column can sort the table; names open the company's dossier. Server
// side: src/index/league.js.

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const pts = (v) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
const SORTS = [['share', 'News share'], ['x', 'X share'], ['mood', 'Mood'], ['shipped', 'Shipped'], ['odds', 'Best-model odds']];

export function createLeague({ $, esc, setHtml, state, reducedMotion }) {
  const view = { s: 'share' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#league(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const s = new URLSearchParams(m[1] || '').get('s');
    view.s = SORTS.some(([k]) => k === s) ? s : 'share';
    return 'league';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 15 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/league');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'league') render();
  }

  const value = (r) => ({ share: r.share, x: r.xShare, mood: r.mood ?? -999, shipped: r.shipped, odds: r.odds?.yes ?? -1 })[view.s];

  function spark(days) {
    const W = 90, H = 22;
    const max = Math.max(...days) || 1;
    const p = days.map((v, i) => `${(1 + (i / (days.length - 1)) * (W - 2)).toFixed(1)},${(H - 2 - (v / max) * (H - 5)).toFixed(1)}`).join(' ');
    return `<svg class="lg-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${p}"/></svg>`;
  }

  function move(r) {
    const d = r.prevRank - r.rank;
    if (!d) return '<span class="lg-mv same" aria-label="Same place as last week">–</span>';
    return `<span class="lg-mv ${d > 0 ? 'up' : 'down'}" aria-label="${d > 0 ? 'Up' : 'Down'} ${Math.abs(d)} from last week">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  }

  function table(d) {
    const rows = [...d.table].sort((a, b) => value(b) - value(a));
    const max = Math.max(...d.table.map((r) => Math.max(r.share, r.sharePrev))) || 1;
    return `<div class="lg-wrap"><table class="lg-table">
      <thead><tr><th scope="col">#</th><th scope="col">Lab</th><th scope="col">Share of the news<small>this week · last week’s mark</small></th><th scope="col" class="lg-hide">14 days</th><th scope="col">X share</th><th scope="col">Mood</th><th scope="col">Shipped</th><th scope="col">Best-model odds</th></tr></thead>
      <tbody>${rows.map((r, i) => {
        const oddsCh = r.odds?.prev != null ? Math.round((r.odds.yes - r.odds.prev) * 100) : null;
        return `<tr style="--i:${i}">
          <td class="lg-rank"><b>${r.rank}</b>${move(r)}</td>
          <th scope="row"><a href="#co/${esc(r.key)}">${esc(r.label)}</a></th>
          <td class="lg-share"><span class="lg-barw"><span class="lg-bar" style="width:${((100 * r.share) / max).toFixed(1)}%"></span><i class="lg-prev" style="left:${((100 * r.sharePrev) / max).toFixed(1)}%" title="Last week ${pct(r.sharePrev)}"></i></span><b>${pct(r.share)}</b></td>
          <td class="lg-hide">${spark(r.days)}</td>
          <td class="lg-num">${pct(r.xShare)}</td>
          <td class="lg-num"><span class="lg-mood ${r.mood == null ? '' : r.mood >= 0 ? 'good' : 'bad'}">${esc(pts(r.mood))}</span></td>
          <td class="lg-num">${r.shipped}</td>
          <td class="lg-num">${r.odds ? `${Math.round(r.odds.yes * 100)}%${oddsCh ? ` <small class="${oddsCh > 0 ? 'up' : 'down'}">${oddsCh > 0 ? '+' : '−'}${Math.abs(oddsCh)}</small>` : ''}` : '–'}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function page(d) {
    const s = d.stats;
    return `<div class="tl-stats">
        ${s.leader ? `<p><b>${esc(s.leader.label)}</b><span>leads with ${pct(s.leader.share)} of this week’s ${d.totals.articles.toLocaleString('en')} articles</span></p>` : ''}
        ${s.riser ? `<p><b>${esc(s.riser.label)}</b><span>rose most: ${s.riser.change >= 0 ? '+' : '−'}${Math.abs(s.riser.change * 100).toFixed(1)} points of the news</span></p>` : ''}
        ${s.favourite ? `<p><b>${esc(s.favourite.label)}</b><span>${Math.round(s.favourite.odds.yes * 100)}% to have the best model at year end on Polymarket</span></p>` : ''}
      </div>
      <nav class="pd-chips ct-themes" aria-label="Sort by">${SORTS.map(([k, l]) => `<a class="chip${view.s === k ? ' on' : ''}" href="#league${k === 'share' ? '' : `?s=${k}`}">${esc(l)}</a>`).join('')}</nav>
      ${table(d)}
      <p class="rail-note">Ranks are by share of the week’s stored articles that name the lab in the headline (with an AI word for Google, Meta, Apple, Amazon and Microsoft), each copy once; last week’s rank and share are the seven days before. X share is the same for posts from the accounts we follow. Mood is good-minus-bad headlines in points (<a href="#mood">how</a>), shipped is changes on <a href="#shipped">Shipped</a> this week${d.market ? `, and the odds come from <a href="${esc(d.market.url)}" target="_blank" rel="noopener">${esc(d.market.title)}</a> with the change over seven days in points` : ''}. Every lab has a <a href="#co">dossier</a>. <a href="/api/league">JSON</a></p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#leagueView');
    document.title = `The AI league table · ${site}`;
    const head = `<header class="topic-head lg-head"><p class="kicker">League table</p><h1>The AI league table</h1>
      <p class="topic-sum">The big labs ranked by how much of this week’s news is about them, with who’s rising, how their headlines read, what they shipped, and who the market thinks has the best model.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The league table needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="lg-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  return { route, render };
}
