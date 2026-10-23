// The compute race (#chips?k=<kind>&c=<camp>&e=<id>): a year of AI chip
// news. Monthly events stacked by what happened, each camp's share of chip
// headlines as small multiples on one scale, the GPU counts named in deals
// on a log scale, the export-control timeline, and event cards with every
// report. Server side: src/index/chips.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const shortDay = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const monFmt = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const monLong = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const count = (v) => (v >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : v >= 1e3 ? `${+(v / 1e3).toPrecision(3)}K` : String(v));
// Four series and money in grey.
const SERIES = ['launch', 'deal', 'shortage', 'export', 'money'];
const color = (k) => (k === 'money' ? 'var(--cp-grey)' : `var(--s${SERIES.indexOf(k) + 1}c)`);
const SHORT = { nvidia: 'Nvidia', amd: 'AMD', custom: 'Cloud chips', china: 'Chinese chips', startups: 'Startups', supply: 'Memory, fabs' };

export function createChips({ $, esc, setHtml, state, reducedMotion }) {
  const view = { k: '', c: '', e: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let scrolled = '';

  function route(hash) {
    const m = /^#chips(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.k = (p.get('k') || '').replace(/[^a-z]/g, '').slice(0, 20);
    view.c = (p.get('c') || '').replace(/[^a-z]/g, '').slice(0, 20);
    view.e = (p.get('e') || '').replace(/[^a-z0-9-]/g, '').slice(0, 80);
    return 'chips';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/chips');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'chips') render();
  }

  const href = (over = {}) => {
    const v = { ...view, e: '', ...over };
    const p = new URLSearchParams();
    for (const k of ['k', 'c', 'e']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#chips${s ? `?${s}` : ''}`;
  };
  const matches = (x) => (!view.k || x.kind === view.k) && (!view.c || x.camp === view.c);

  function columns(d, narrow) {
    const W = narrow ? 360 : 560, H = 210, L = 28, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.n));
    const step = max > 40 ? 20 : max > 16 ? 10 : 4;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      let acc = 0;
      const segs = SERIES.map((k) => {
        const v = m.kinds[k];
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="cp-seg${view.k && view.k !== k ? ' dim' : ''}" style="fill:${color(k)}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="cp-col" style="--i:${i}" data-m="${i}">${segs}<rect class="cp-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section><h2 class="when">What happened<span>chip events by month; tap the legend to filter</span></h2>
      <ul class="tr-legend">${SERIES.map((k) => `<li style="--c:${color(k)}"><a class="cp-leg${view.k === k ? ' on' : ''}" href="${esc(href({ k: view.k === k ? '' : k }))}"><i class="sw"></i>${esc(d.labels.kinds[k])}</a></li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${monLong(m.m)}: ${plural(m.n, 'event')}`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // Each camp's share of the month's chip headlines, one small chart each, one scale.
  function camps(d, narrow) {
    const share = (m, k) => (m.headlines ? m.camps[k] / m.headlines : 0);
    const max = Math.max(0.05, ...d.months.flatMap((m) => d.camps.map((c) => share(m, c.key))));
    const W = narrow ? 170 : 200, H = 80, T = 6, B = 16;
    const bw = W / d.months.length;
    const panels = d.camps.map((c, ci) => {
      const on = view.c === c.key;
      const bars = d.months.map((m, i) => {
        const v = share(m, c.key);
        const h = (v / max) * (H - T - B);
        return `<g class="cp-cc" data-c="${c.key}" data-m="${i}" style="--i:${i}">${v ? `<rect class="cp-cbar" x="${(i * bw + bw * 0.16).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5"/>` : ''}<rect class="cp-hit" x="${(i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>`;
      }).join('');
      const pts = Math.round((c.share90 - c.sharePrev) * 100);
      return `<a class="cp-panel${on ? ' on' : ''}${view.c && !on ? ' dim' : ''}" href="${esc(href({ c: on ? '' : c.key }))}" style="--i:${ci}">
        <p class="cp-ph"><b>${esc(SHORT[c.key])}</b><span>${Math.round(c.share90 * 100)}%${c.sharePrev ? ` · ${pts >= 0 ? '+' : '−'}${Math.abs(pts)} pts` : ''}</span></p>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${c.label}: ${d.months.map((m) => `${monLong(m.m)} ${Math.round(share(m, c.key) * 100)}%`).join(', ')}`)}">
          <line class="cp-base" x1="0" x2="${W}" y1="${H - B}" y2="${H - B}"/>${bars}
          <text class="lc-xt" x="0" y="${H - 3}">${esc(monFmt(d.months[0].m))}</text><text class="lc-xt" x="${W}" y="${H - 3}" text-anchor="end">${esc(monFmt(d.months.at(-1).m))}</text>
        </svg></a>`;
    }).join('');
    return `<section class="cp-camps"><h2 class="when">The camps<span>share of chip headlines naming each, by month, one scale; last 90 days and the change in points; tap to filter</span></h2><div class="cp-panels">${panels}</div></section>`;
  }

  // GPU counts on a log scale, so a 24,000-chip cluster and a 3-million-chip plan both read.
  function units(d) {
    const rows = d.units.slice(0, 10);
    if (!rows.length) return '';
    const lo = Math.log10(Math.min(...rows.map((r) => r.units)) / 2), hi = Math.log10(Math.max(...rows.map((r) => r.units)));
    const w = (v) => Math.max(3, ((Math.log10(v) - lo) / (hi - lo)) * 100);
    return `<section class="cp-units"><h2 class="when">GPU counts<span>chips named in deals and plans, log scale</span></h2><ol>${rows.map((r, i) => `<li style="--i:${i}"><a href="${esc(href({ e: r.id }))}" data-e="${esc(r.id)}">
      <span class="cp-who">${esc(r.buyer || 'Buyer not named')}</span><span class="cp-bar" style="width:${w(r.units).toFixed(1)}%"></span><small>${esc(count(r.units))}</small></a></li>`).join('')}</ol></section>`;
  }

  function exportsList(d) {
    if (!d.exports.length) return '';
    return `<section class="cp-exports"><h2 class="when">Export controls<span>the US–China chip fight, newest first</span></h2><ol>${d.exports.slice(0, 10).map((x, i) => `<li style="--i:${i}"><time>${esc(shortDay(x.at))}</time><a href="${esc(href({ e: x.id, k: 'export' }))}">${esc(x.title)}</a>${x.outlets > 1 ? `<small>${x.outlets} outlets</small>` : ''}</li>`).join('')}</ol></section>`;
  }

  function card(x, i) {
    const d = data.d;
    return `<li class="cp-card" id="cp-${esc(x.id)}" style="--i:${Math.min(i, 14)}">
      <details${view.e === x.id ? ' open' : ''}>
        <summary>
          <p class="ct-meta"><span class="cp-kind" style="--c:${color(x.kind)}">${esc(d.labels.kinds[x.kind])}</span>${x.camp ? `<a class="tl-chip" href="${esc(href({ c: x.camp }))}">${esc(d.labels.camps[x.camp])}</a>` : ''}</p>
          <h3>${esc(x.title)}</h3>
          <p class="ct-sub">${x.units ? `<b class="cp-num">${esc(count(x.units))} chips${x.buyer ? ` · ${esc(x.buyer)}` : ''}</b> · ` : ''}${esc(dayFmt(x.at))} · ${plural(x.outlets, 'outlet')}</p>
        </summary>
        <ol class="ct-events">${x.reports.map((e) => `<li><p class="ct-ev-h">${esc(dayFmt(e.at))}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.events.filter(matches);
    const recent = d.generatedAt - 30 * 86400e3;
    list.sort((a, b) => (b.id === view.e) - (a.id === view.e) || (b.at >= recent) - (a.at >= recent) || (a.at >= recent && b.at >= recent ? b.outlets - a.outlets : 0) || b.at - a.at);
    const s = d.stats;
    const change = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}% on the 90 days before` : 'none in the 90 days before');
    const nv = d.camps.find((c) => c.key === 'nvidia');
    const labels = [view.k && d.labels.kinds[view.k], view.c && d.labels.camps[view.c]].filter(Boolean);
    return `<div class="tl-stats">
        <p><b>${s.n90}</b><span>chip events in the last 90 days (${esc(change(s.n90, s.prev90))})</span></p>
        <p><b>${Math.round((nv?.share90 || 0) * 100)}%</b><span>of chip headlines name Nvidia, ${Math.round((nv?.sharePrev || 0) * 100)}% in the 90 days before</span></p>
        <p><b>${s.export90}</b><span>export-control stories and ${s.shortage90} about shortages in 90 days</span></p>
        ${s.biggestOrder ? `<p><b>${esc(count(s.biggestOrder.units))}</b><span>chips in the biggest plan named${s.biggestOrder.buyer ? `: ${esc(s.biggestOrder.buyer)}` : `: <a href="${esc(s.biggestOrder.url)}" target="_blank" rel="noopener">${esc(s.biggestOrder.title.length > 70 ? `${s.biggestOrder.title.slice(0, 68)}…` : s.biggestOrder.title)}</a>`}</span></p>` : ''}
      </div>
      <div class="cp-top">${columns(d, narrow)}${camps(d, narrow)}</div>
      <div class="cp-grid">${units(d)}${exportsList(d)}</div>
      <nav class="pd-chips ct-themes" aria-label="Camp"><a class="chip${view.c ? '' : ' on'}" href="${esc(href({ c: '' }))}">All camps</a>${d.camps.filter((c) => c.events).map((c) => `<a class="chip${view.c === c.key ? ' on' : ''}" href="${esc(href({ c: view.c === c.key ? '' : c.key }))}">${esc(c.label)} <small>${c.events}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Events')}<span>${list.length}; the last month’s most carried first${narrow && list.length > 30 ? ', 30 shown' : ''}</span>${labels.length ? '<a class="tl-clear" href="#chips">Show all</a>' : ''}</h2>
        <ol class="ct-cases">${list.slice(0, narrow ? 30 : 80).map(card).join('') || '<li class="rail-note">No events match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} chip headlines in English over the last year. A headline counts when it names silicon (GPUs, TPUs, accelerators, HBM, fabs) and says what happened; stock tips, gaming cards, phones and model releases are left out. A headline counts toward every camp it names, so shares can add up to more than 100%. The same camp’s news of one kind told the same way within five days is one event. Data center projects and power are on <a href="#buildout">The buildout</a>; chip money across AI on <a href="#deals">Deals</a>. <a href="/api/chips">JSON</a></p>
      <div class="ac-tip cp-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#chipsView');
    document.title = `The compute race · ${site}`;
    const head = `<header class="topic-head cp-head"><p class="kicker">Compute</p><h1>The compute race</h1>
      <p class="topic-sum">The chips AI runs on: Nvidia and its challengers, who’s buying how many GPUs, the shortages, and the export controls between the US and China.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The compute race needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="cp-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.e && scrolled !== view.e) {
      scrolled = view.e;
      // After the router's scroll to the top.
      requestAnimationFrame(() => document.getElementById(`cp-${view.e}`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
  }

  function hover(e) {
    const tip = $('#chipsView .cp-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.cp-col');
    const cc = t?.closest?.('.cp-cc');
    const un = t?.closest?.('.cp-units a');
    let html = '';
    let el = null;
    if (col) {
      const m = d.months[+col.dataset.m];
      el = col;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p><p><b>${plural(m.n, 'event')}</b> from ${m.headlines} chip headlines</p>${SERIES.map((k) => (m.kinds[k] ? `<p><i class="sw" style="--c:${color(k)}"></i>${esc(d.labels.kinds[k])}: <b>${m.kinds[k]}</b></p>` : '')).join('')}`;
    } else if (cc) {
      const m = d.months[+cc.dataset.m];
      el = cc;
      html = `<p class="tt-h">${esc(d.labels.camps[cc.dataset.c])}, ${esc(monLong(m.m))}</p><p><b>${m.headlines ? Math.round((100 * m.camps[cc.dataset.c]) / m.headlines) : 0}%</b> of chip headlines (${m.camps[cc.dataset.c]} of ${m.headlines})</p>`;
    } else if (un) {
      const r = d.units.find((x) => x.id === un.dataset.e);
      if (r) {
        el = un.querySelector('.cp-bar');
        html = `<p class="tt-h">${esc(r.units.toLocaleString('en'))} chips</p><p>${esc(r.unitsTitle || r.title)}</p><p><small>${esc(dayFmt(r.at))}</small></p>`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#chipsView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
