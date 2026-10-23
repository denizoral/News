// Early signals (#signals?f=several|people): what X is talking about that
// the press hasn't covered, grouped by meaning with how many accounts posted
// it and how close the nearest article came; then stories the press picked
// up after X, with how long it took on a log scale, and the accounts most
// often ahead. Server side: src/index/signals.js.

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60e3);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const span = (m) => (m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 6) / 10}h`.replace('.0h', 'h') : `${Math.round(m / 1440)}d`);
const MARKETS = /^(?:polymarket|kalshi|polymarketintel)$/i;

export function createSignals({ $, esc, setHtml, state, reducedMotion }) {
  const view = { f: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#signals(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const f = new URLSearchParams(m[1] || '').get('f');
    view.f = ['several', 'people'].includes(f) ? f : '';
    return 'signals';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 5 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/signals');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'signals') render();
  }

  const xHref = (h) => `#account/${encodeURIComponent(h)}`;

  function card(s, i) {
    return `<li class="sg-card" style="--i:${Math.min(i, 16)}">
      <p class="sg-who">${s.avatar ? `<img src="${esc(s.avatar)}" alt="" width="28" height="28" loading="lazy" data-fallback="remove">` : ''}<a href="${esc(xHref(s.handle))}">@${esc(s.handle)}</a><time>${esc(ago(s.at))}</time>${s.accounts > 1 ? `<span class="sg-n">${s.accounts} accounts</span>` : ''}</p>
      <p class="sg-text"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.text.length > 280 ? `${s.text.slice(0, 278)}…` : s.text)}</a></p>
      ${s.accounts > 1 ? `<p class="sg-also">Also: ${s.handles.filter((h) => h !== s.handle).map((h) => `<a href="${esc(xHref(h))}">@${esc(h)}</a>`).join(' ')}</p>` : ''}
      ${s.nearest ? `<p class="sg-near">Closest coverage (${Math.round(s.nearest.sim * 100)}% alike): <a href="${esc(s.nearest.url)}" target="_blank" rel="noopener">${esc(s.nearest.title)}</a></p>` : ''}
    </li>`;
  }

  // How long the press took after X, one bar per story, log scale.
  function caught(d) {
    if (!d.caught.length) return '';
    const list = d.caught.slice(0, 14);
    const lo = Math.log10(5), hi = Math.log10(Math.max(60 * 24, ...list.map((c) => c.lead)));
    const w = (m) => Math.max(2, ((Math.log10(Math.max(5, m)) - lo) / (hi - lo)) * 100);
    return `<section class="sg-caught"><h2 class="when">The press caught up<span>stories X had first, with how long until the first article; log scale</span></h2>
      <ol>${list.map((c, i) => `<li style="--i:${i}">
        <p class="sg-ct"><a href="${esc(c.article.url)}" target="_blank" rel="noopener">${esc(c.article.title)}</a><small><a href="${esc(xHref(c.handle))}">@${esc(c.handle)}</a> first, then ${esc(c.article.source || 'the press')}</small></p>
        <span class="sg-bar"><i style="width:${w(c.lead).toFixed(1)}%"></i></span><b>${esc(span(c.lead))}</b></li>`).join('')}</ol>
      <p class="sg-scale"><span>5m</span><span>1h</span><span>1 day</span></p></section>`;
  }

  function ahead(d) {
    if (!d.ahead.length) return '';
    return `<section class="sg-ahead"><h2 class="when">Ahead most often<span>accounts with a post before the press, 48 hours</span></h2><ol>${d.ahead.map((a) => `<li><a href="${esc(xHref(a.handle))}">@${esc(a.handle)}</a><b>${a.n}</b></li>`).join('')}</ol>
      <p class="rail-note">Over longer periods: <a href="#accounts">Who’s first on X</a>.</p></section>`;
  }

  function page(d) {
    const s = d.stats;
    const list = d.signals.filter((x) => (view.f === 'several' ? x.accounts >= 2 : view.f === 'people' ? !x.handles.every((h) => MARKETS.test(h)) : true));
    return `<div class="tl-stats">
        <p><b>${s.signals}</b><span>things on X with no close article yet, ${s.multi} posted by several accounts</span></p>
        <p><b>${Math.round(s.uncovered * 100)}%</b><span>of ${d.posts} AI posts in ${d.hours} hours have no close coverage</span></p>
        <p><b>${s.caught}</b><span>stories the press picked up after X${s.medianLead != null ? `, ${esc(span(s.medianLead))} later at the median` : ''}</span></p>
      </div>
      <div class="sg-grid">
        <section class="sg-main"><h2 class="when">On X, not in the news<span>by how many accounts posted it, then newest</span></h2>
          <nav class="pd-chips ct-themes" aria-label="Filter"><a class="chip${view.f ? '' : ' on'}" href="#signals">All</a><a class="chip${view.f === 'several' ? ' on' : ''}" href="#signals?f=several">Several accounts</a><a class="chip${view.f === 'people' ? ' on' : ''}" href="#signals?f=people">Leave out market accounts</a></nav>
          <ol class="sg-list">${list.map(card).join('') || '<li class="rail-note">Nothing on X is ahead of the press right now.</li>'}</ol></section>
        <div class="sg-side">${caught(d)}${ahead(d)}</div>
      </div>
      <p class="rail-note">Every AI post from the tracked X accounts in the last ${d.hours} hours is compared by meaning with the ${d.articles.toLocaleString('en')} articles stored over the last three days. A post counts as covered when an article is at least 80% alike (sentence embeddings of the headline and summary start). Unconfirmed posts are often rumours, leaks or jokes: they’re signals, not news. Market accounts (Polymarket, Kalshi) count only for their AI posts. <a href="/api/signals">JSON</a></p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#signalsView');
    document.title = `Early signals · ${site}`;
    const head = `<header class="topic-head sg-head"><p class="kicker">Early signals</p><h1>On X before the news</h1>
      <p class="topic-sum">What the AI accounts we follow are posting that no outlet has covered yet, and how long the press takes to catch up.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Early signals need the live server.</p>`);
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
    setHtml(host, `${head}<div class="sg-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  return { route, render };
}
