// Research papers (#papers?t=<theme>): what AI researchers publish, from
// Hugging Face paper pages. Each theme's share of the month's papers as small
// multiples on one scale (tap to filter), words rising in the last 30 days of
// titles, papers whose name made the news with those headlines, and the
// latest papers. Server side: src/index/papers.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const monFmt = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const monLong = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;

export function createPapers({ $, esc, setHtml, state, reducedMotion }) {
  const view = { t: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#papers(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.t = (new URLSearchParams(m[1] || '').get('t') || '').replace(/[^a-z]/g, '').slice(0, 20);
    return 'papers';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/papers');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'papers') render();
  }

  const href = (t) => `#papers${t ? `?t=${t}` : ''}`;

  // One small chart per theme: its share of each month's papers, one scale.
  function themes(d, narrow) {
    const share = (m, k) => (m.n ? m.themes[k] / m.n : 0);
    const max = Math.max(0.05, ...d.months.flatMap((m) => d.themes.map((t) => share(m, t.key))));
    // Close to the drawn width, so the month labels stay at their own size.
    const W = narrow ? 170 : 380, H = 90, T = 4, B = 15;
    const bw = W / d.months.length;
    return `<section class="pp-themes"><h2 class="when">Themes<span>share of each month’s papers, one scale; a paper can have several; tap to filter</span></h2><div class="pp-panels">${d.themes.map((t, ti) => {
      const on = view.t === t.key;
      const bars = d.months.map((m, i) => {
        const v = share(m, t.key);
        const h = (v / max) * (H - T - B);
        return `<g class="pp-c" data-t="${t.key}" data-m="${i}" style="--i:${i}">${v ? `<rect x="${(i * bw + bw * 0.16).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5"/>` : ''}<rect class="pp-hit" x="${(i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>`;
      }).join('');
      return `<a class="pp-panel${on ? ' on' : ''}${view.t && !on ? ' dim' : ''}" href="${esc(href(on ? '' : t.key))}" style="--i:${ti}">
        <p class="pp-ph"><b>${esc(t.label)}</b><span>${Math.round(t.share * 100)}%</span></p>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${t.label}: ${d.months.map((m) => `${monLong(m.m)} ${Math.round(share(m, t.key) * 100)}%`).join(', ')}`)}">
          <line class="pp-base" x1="0" x2="${W}" y1="${H - B}" y2="${H - B}"/>${bars}
          <text class="lc-xt" x="0" y="${H - 3}">${esc(monFmt(d.months[0].m))}</text><text class="lc-xt" x="${W}" y="${H - 3}" text-anchor="end">${esc(monFmt(d.months.at(-1).m))}</text>
        </svg></a>`;
    }).join('')}</div></section>`;
  }

  function rising(d) {
    if (!d.rising.length) return '';
    const max = Math.max(...d.rising.map((r) => r.lift));
    return `<section class="pp-rising"><h2 class="when">Rising words<span>in the last 30 days of titles against the 90 before</span></h2>
      <p class="pp-words">${d.rising.map((r, i) => `<span style="--s:${(0.85 + (r.lift / max) * 0.6).toFixed(2)};--i:${i}" title="${r.n} titles in 30 days, ${r.prev} in the 90 before: ${r.lift}× as common">${esc(r.w)}<small>${r.lift}×</small></span>`).join('')}</p></section>`;
  }

  function inNews(d) {
    if (!d.inNews.length) return '';
    return `<section class="pp-news"><h2 class="when">Papers in the news<span>named papers from the last 60 days that headlines picked up</span></h2><ol>${d.inNews.slice(0, 12).map((p, i) => `<li style="--i:${i}">
      <p class="pp-pn"><a href="${esc(p.url)}" target="_blank" rel="noopener"><b>${esc(p.name)}</b>${esc(p.title.slice(p.name.length).replace(/^:\s*/, ': '))}</a><small>${esc(dayFmt(p.at))}</small></p>
      <ul>${p.news.slice(0, 3).map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><small>${esc(h.source)} · ${esc(dayFmt(h.at))}</small></li>`).join('')}</ul></li>`).join('')}</ol></section>`;
  }

  function latest(d, narrow) {
    const list = d.latest.filter((p) => !view.t || p.themes.includes(view.t)).slice(0, narrow ? 25 : 50);
    return `<section class="pp-latest"><h2 class="when">${esc(view.t ? d.labels.themes[view.t] : 'Latest papers')}<span>newest first</span>${view.t ? '<a class="tl-clear" href="#papers">Show all</a>' : ''}</h2><ol>${list.map((p, i) => `<li style="--i:${Math.min(i, 20)}"><a href="${esc(p.url)}" target="_blank" rel="noopener">${p.name ? `<b>${esc(p.name)}</b>${esc(p.title.slice(p.name.length))}` : esc(p.title)}</a>
      <small>${esc(dayFmt(p.at))}${p.themes.length ? ` · ${p.themes.map((t) => `<a href="${esc(href(t))}">${esc(d.labels.themes[t])}</a>`).join(', ')}` : ''}</small></li>`).join('') || '<li class="rail-note">No papers on this theme lately.</li>'}</ol></section>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const s = d.stats;
    const top = [...d.themes].sort((a, b) => b.share - a.share)[0];
    const change = s.prev30 ? `${s.last30 >= s.prev30 ? '+' : '−'}${Math.abs(Math.round(((s.last30 - s.prev30) / s.prev30) * 100))}% on the 30 days before` : '';
    return `<div class="tl-stats">
        <p><b>${s.last30.toLocaleString('en')}</b><span>papers in the last 30 days${change ? ` (${esc(change)})` : ''}</span></p>
        ${top ? `<p><b>${Math.round(top.share * 100)}%</b><span>about ${esc(top.label.toLowerCase())}, the biggest theme in the last two months</span></p>` : ''}
        <p><b>${s.inNews}</b><span>papers whose name made the news in 60 days</span></p>
        <p><b>${s.papers.toLocaleString('en')}</b><span>papers in the last year</span></p>
      </div>
      ${themes(d, narrow)}
      <div class="pp-grid">${inNews(d)}${rising(d)}</div>
      ${latest(d, narrow)}
      <p class="rail-note">From the Hugging Face paper pages the crawler stores, each title once. Themes are read from titles, so a paper can have several or none. A paper is “in the news” when a headline outside Hugging Face and arXiv carries its name as written, and a plain-word name (“Mosaic”) needs two more words from the title as well. How many papers the crawler finds each month varies, so the themes are shares. <a href="/api/papers">JSON</a></p>
      <div class="ac-tip pp-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#papersView');
    document.title = `Research papers · ${site}`;
    const head = `<header class="topic-head pp-head"><p class="kicker">Research</p><h1>What researchers are publishing</h1>
      <p class="topic-sum">AI papers by theme month by month, the words suddenly everywhere in titles, and the papers that crossed over into the news.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Research papers need the live server.</p>`);
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
    setHtml(host, `${head}<div class="pp-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  function hover(e) {
    const tip = $('#papersView .pp-tip');
    const d = data.d;
    if (!tip || !d) return;
    const c = e.type === 'pointerleave' ? null : e.target?.closest?.('.pp-c');
    const m = c && d.months[+c.dataset.m];
    if (!m) { tip.hidden = true; return; }
    const n = m.themes[c.dataset.t];
    setHtml(tip, `<p class="tt-h">${esc(d.labels.themes[c.dataset.t])}, ${esc(monLong(m.m))}</p><p><b>${m.n ? Math.round((100 * n) / m.n) : 0}%</b> of ${plural(m.n, 'paper')} (${n})</p>`);
    tip.hidden = false;
    const host = $('#papersView').getBoundingClientRect();
    const r = c.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
