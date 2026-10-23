// AI and jobs (#jobs?c=<company>&r=<role>): the layoffs companies tie to AI.
// Monthly rounds of cuts stacked by why AI comes into it, the argument over
// whether AI is the reason as diverging bars (worry above the line, "it's an
// excuse" below), companies by jobs named (tap to filter), each round of
// cuts as a card with its reports, both sides of the argument, and the kinds
// of work named. Server side: src/index/jobs.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'short' });
const monLong = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const num = (n) => (n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString('en'));

// Why AI comes into it, in a fixed colour order; "AI in the picture" and
// "says it isn't AI" share the last slot.
const SERIES = [['replaced', 'AI does the work'], ['refocus', 'Refocus on AI'], ['funding', 'To pay for AI'], ['other', 'Other, or says it isn’t AI']];
const SLOT = { replaced: 0, refocus: 1, funding: 2, cited: 3, denied: 3 };

export function createJobs({ $, esc, setHtml, state, reducedMotion }) {
  const view = { c: '', r: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#jobs(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.c = (p.get('c') || '').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 40);
    view.r = (p.get('r') || '').replace(/[^a-z]/g, '');
    return 'jobs';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/jobs');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'jobs') render();
  }

  const href = (c, r) => {
    const p = new URLSearchParams();
    if (c) p.set('c', c);
    if (r) p.set('r', r);
    const s = p.toString();
    return `#jobs${s ? `?${s}` : ''}`;
  };

  const slots = (m) => {
    const v = [0, 0, 0, 0];
    for (const [k, n] of Object.entries(m.reasons)) v[SLOT[k]] += n;
    return v;
  };

  function rounds(d, narrow) {
    const W = narrow ? 360 : 560, H = 200, L = 28, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.rounds));
    const step = max > 20 ? 10 : max > 8 ? 4 : 2;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      let acc = 0;
      const segs = slots(m).map((v, s) => {
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="jb-seg s${s + 1}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="jb-col" style="--i:${i}" data-m="${i}">${segs}<rect class="jb-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section><h2 class="when">Rounds of cuts<span>by month, and why AI comes into it</span></h2>
      <ul class="tr-legend">${SERIES.map(([, l], s) => `<li style="--c:var(--s${s + 1}c)"><i class="sw"></i>${esc(l)}</li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${m.m}: ${plural(m.rounds, 'round')} of cuts, ${num(m.jobs)} jobs named`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // The argument: worry above the line, scepticism below, one scale.
  function argument(d, narrow) {
    const W = narrow ? 360 : 560, H = 200, L = 28, R = 6, T = 10, B = 22;
    const mid = T + (H - T - B) * 0.62;
    const max = Math.max(4, ...d.months.map((m) => Math.max(m.alarm, m.skeptic * 1.7)));
    const step = max > 40 ? 20 : max > 16 ? 10 : 5;
    const top = Math.ceil(max / step) * step;
    const k = (mid - T) / top;
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const down = [];
    for (let v = step; mid + v * k <= H - B + 0.5; v += step) down.push(v);
    const cols = d.months.map((m, i) => {
      const x = (L + i * bw + bw * 0.18).toFixed(1), w = (bw * 0.64).toFixed(1);
      return `<g class="jb-arg" style="--i:${i}" data-m="${i}">
        ${m.alarm ? `<rect class="jb-up" x="${x}" y="${(mid - m.alarm * k).toFixed(1)}" width="${w}" height="${Math.max(1, m.alarm * k - 1).toFixed(1)}" rx="2"/>` : ''}
        ${m.skeptic ? `<rect class="jb-down" x="${x}" y="${(mid + 1).toFixed(1)}" width="${w}" height="${Math.max(1, m.skeptic * k - 1).toFixed(1)}" rx="2"/>` : ''}
        <rect class="jb-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section><h2 class="when">Is AI really the reason?<span>headlines a month on each side</span></h2>
      <ul class="tr-legend"><li style="--c:var(--jb-up)"><i class="sw"></i>AI is taking jobs</li><li style="--c:var(--jb-down)"><i class="sw"></i>It’s an excuse, or overstated</li></ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${m.m}: ${m.alarm} worried, ${m.skeptic} sceptical`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${(mid - v * k).toFixed(1)}" y2="${(mid - v * k).toFixed(1)}"/><text x="${L - 6}" y="${(mid - v * k).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${down.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${(mid + v * k).toFixed(1)}" y2="${(mid + v * k).toFixed(1)}"/><text x="${L - 6}" y="${(mid + v * k).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        <line class="jb-mid" x1="${L}" x2="${W - R}" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}"/>
        ${cols}
      </svg></section>`;
  }

  function companies(d) {
    const rows = d.companies.filter((c) => c.jobs).slice(0, 10);
    const max = Math.max(1, ...rows.map((c) => c.jobs));
    const rest = d.companies.filter((c) => !c.jobs).slice(0, 10);
    return `<section class="jb-cos"><h2 class="when">Jobs named<span>by company over the year; tap to filter</span></h2>
      <ol>${rows.map((c, i) => {
        const on = view.c === c.key;
        return `<li style="--i:${i}"><a href="${esc(href(on ? '' : c.key, view.r))}" class="${on ? 'on' : ''}${view.c && !on ? ' dim' : ''}" data-c="${esc(c.key)}">
          <span class="jb-co">${esc(c.label)}</span><span class="jb-bar" style="width:${((100 * c.jobs) / max).toFixed(1)}%"></span><small>${num(c.jobs)}</small></a></li>`;
      }).join('')}</ol>
      ${rest.length ? `<p class="jb-rest">Without a figure: ${rest.map((c) => `<a class="${view.c === c.key ? 'on' : ''}" href="${esc(href(view.c === c.key ? '' : c.key, view.r))}">${esc(c.label)}</a>`).join(', ')}</p>` : ''}
    </section>`;
  }

  function card(c, i) {
    const big = c.count ? `${c.count.toLocaleString('en')}` : c.share ? `${c.share}%` : '';
    const what = c.count ? 'jobs' : c.share ? 'of staff' : 'jobs, number not given';
    const slot = SLOT[c.reason];
    return `<li class="jb-cut" style="--i:${Math.min(i, 14)}">
      <details>
        <summary>
          <p class="ct-meta"><span class="jb-why s${slot + 1}">${esc(d().labels[c.reason])}</span>${c.status === 'planned' ? '<span class="jb-plan">Planned</span>' : ''}</p>
          <h3><a class="jb-name" href="${esc(href(c.company.key, view.r))}">${esc(c.company.label)}</a></h3>
          <p class="jb-n">${big ? `<b>${esc(big)}</b> ` : ''}<span>${esc(what)}</span></p>
          <p class="ct-sub">${esc(dayFmt(c.at))} · ${plural(c.outlets, 'outlet')}</p>
          <p class="ct-latest">${esc(c.reports[0].title)}</p>
        </summary>
        <ol class="ct-events">${c.reports.map((e) => `<li><p class="ct-ev-h">${esc(dayFmt(e.at))}${e.outlets > 1 ? ` · ${e.outlets} outlets` : ''}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  const d = () => data.d;

  const item = (e) => `<li><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a><small>${esc(e.source)} · ${esc(dayFmt(e.at))}${e.outlets > 1 ? ` · ${e.outlets} outlets` : ''}</small></li>`;

  function debate(dd) {
    return `<section class="jb-sides"><h2 class="when">The argument<span>the most-carried headlines on each side, newest first</span></h2>
      <div class="jb-two">
        <div class="jb-side up"><h3>AI is taking jobs</h3><ol>${dd.debate.alarm.slice(0, 10).map(item).join('')}</ol></div>
        <div class="jb-side down"><h3>It’s an excuse, or overstated</h3><ol>${dd.debate.skeptic.slice(0, 10).map(item).join('') || '<li class="rail-note">Nothing yet.</li>'}</ol></div>
      </div></section>`;
  }

  function roles(dd) {
    const r = dd.roles.find((x) => x.key === view.r);
    return `<section class="jb-roles"><h2 class="when">Whose work<span>the kinds of work named in the coverage</span></h2>
      <nav class="pd-chips" aria-label="Kind of work">${dd.roles.map((x) => `<a class="chip${view.r === x.key ? ' on' : ''}" href="${esc(href(view.c, view.r === x.key ? '' : x.key))}">${esc(x.label)} <small>${x.n}</small></a>`).join('')}</nav>
      ${r ? `<ol class="jb-list">${r.items.map(item).join('')}</ol>` : '<p class="rail-note">Pick a kind of work to see its headlines.</p>'}
    </section>`;
  }

  function page(dd) {
    const narrow = innerWidth < 640;
    const list = dd.cuts.filter((c) => !view.c || c.company.key === view.c);
    const co = dd.companies.find((c) => c.key === view.c) || dd.cuts.find((c) => c.company.key === view.c)?.company;
    const s = dd.stats;
    return `<div class="tl-stats">
        <p><b>${num(s.jobs)}</b><span>jobs named in cuts tied to AI this year</span></p>
        <p><b>${s.rounds}</b><span>rounds of cuts at ${s.companies} ${s.companies === 1 ? 'company' : 'companies'}</span></p>
        <p><b>${Math.round(s.tiedShare * 100)}%</b><span>of the cuts that give a reason say AI does the work, or a refocus on AI</span></p>
        <p><b>${Math.round(s.skepticShare * 100)}%</b><span>of the argument says it’s an excuse or overstated</span></p>
      </div>
      <div class="ct-charts">${rounds(dd, narrow)}${argument(dd, narrow)}</div>
      <div class="jb-grid">${companies(dd)}
        <section><h2 class="when">${esc(co ? co.label : 'Rounds of cuts')}<span>${list.length}, newest first</span>${view.c ? `<a class="tl-clear" href="${esc(href('', view.r))}">Show all</a>` : ''}</h2>
          <ol class="ct-cases">${list.slice(0, 60).map(card).join('') || '<li class="rail-note">No cuts match.</li>'}</ol></section>
      </div>
      ${debate(dd)}
      ${roles(dd)}
      <p class="rail-note">From ${dd.headlines} headlines in English over the last year about AI and work. A round of cuts is a company named with a layoff, read for the headcount or share of staff and why AI comes into it; reports of the same company’s cuts within three weeks are one round, and its figure is the one most reports give. Companies don’t always say how many, and a reason in a headline is the outlet’s framing as much as the company’s. <a href="/api/jobs">JSON</a></p>
      <div class="ac-tip jb-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#jobsView');
    document.title = `AI and jobs · ${site}`;
    const head = `<header class="topic-head jb-head"><p class="kicker">AI and jobs</p><h1>Who is cutting jobs over AI</h1>
      <p class="topic-sum">The layoffs companies tie to AI, how many jobs, why, and the argument over whether AI is really the reason.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">AI and jobs needs the live server.</p>`);
      return;
    }
    load();
    const dd = data.d;
    if (!dd) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:320px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== dd.generatedAt && !reducedMotion();
    drawn = dd.generatedAt;
    setHtml(host, `${head}<div class="jb-page${animate ? ' animate' : ''}">${page(dd)}</div>`);
  }

  function hover(e) {
    const tip = $('#jobsView .jb-tip');
    const dd = data.d;
    if (!tip || !dd) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.jb-col');
    const arg = t?.closest?.('.jb-arg');
    const co = t?.closest?.('.jb-cos a');
    let html = '';
    let el = null;
    if (col) {
      const m = dd.months[+col.dataset.m];
      const v = slots(m);
      el = col;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p>${SERIES.map(([, l], s) => (v[s] ? `<p><i class="ct-sw s${s + 1}"></i>${esc(l)}: <b>${v[s]}</b></p>` : '')).join('')}<p>${plural(m.rounds, 'round')} of cuts${m.jobs ? `, <b>${m.jobs.toLocaleString('en')}</b> jobs named` : ''}</p>`;
    } else if (arg) {
      const m = dd.months[+arg.dataset.m];
      el = arg;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p><p><i class="ct-sw jb-up-sw"></i>AI is taking jobs: <b>${m.alarm}</b></p><p><i class="ct-sw jb-down-sw"></i>It’s an excuse: <b>${m.skeptic}</b></p>`;
    } else if (co) {
      const c = dd.companies.find((x) => x.key === co.dataset.c);
      el = co.querySelector('.jb-bar');
      html = `<p class="tt-h">${esc(c.label)}</p><p><b>${c.jobs.toLocaleString('en')}</b> jobs named in ${plural(c.rounds, 'round')}</p>${Object.entries(c.reasons).map(([k, n]) => `<p><i class="ct-sw s${SLOT[k] + 1}"></i>${esc(dd.labels[k])}: <b>${n}</b></p>`).join('')}`;
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#jobsView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 6)}px`;
  }

  return { route, render, hover };
}
