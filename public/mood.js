// The mood of AI coverage (#mood?c=<company>): points of good news minus bad
// in AI headlines, week by week as diverging bars; each big company's mood
// over 90 days against the 90 before as a dumbbell, with its weekly line and
// this week's headlines when opened; the warmest and coolest outlets; and the
// words driving this week. Server side: src/index/mood.js and
// src/pipeline/tone.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const pts = (v) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
const plural = (n, w) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;
const DAY = 86400e3;

export function createMood({ $, esc, setHtml, state, reducedMotion }) {
  const view = { c: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let opened = '';

  function route(hash) {
    const m = /^#mood(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.c = (new URLSearchParams(m[1] || '').get('c') || '').replace(/[^a-z]/g, '').slice(0, 20);
    return 'mood';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/mood');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'mood') render();
  }

  // Weekly mood around zero: good above, bad below, one scale.
  function weeks(series, narrow, { H = 190, label = 'AI headlines' } = {}) {
    const W = narrow ? 360 : 760, L = 34, R = 6, T = 8, B = 22;
    const vals = series.map((s) => s.mood).filter((v) => v != null);
    const m = Math.max(5, ...vals.map(Math.abs));
    const step = m > 20 ? 10 : 5;
    const top = Math.ceil(m / step) * step;
    const mid = T + (H - T - B) / 2;
    const k = (H - T - B) / 2 / top;
    const bw = (W - L - R) / series.length;
    const ticks = [];
    for (let v = -top; v <= top; v += step) ticks.push(v);
    const bars = series.map((s, i) => {
      const v = s.mood;
      const x = L + i * bw + bw * 0.15;
      const w = bw * 0.7;
      const bar = v == null ? '' : `<rect class="${v >= 0 ? 'mo-good' : 'mo-bad'}" x="${x.toFixed(1)}" y="${(v >= 0 ? mid - v * k : mid).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, Math.abs(v) * k).toFixed(1)}" rx="2"/>`;
      return `<g class="mo-wk" data-i="${i}" style="--i:${i}">${bar}<rect class="mo-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 6 : 4) === 0 && s.start ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(dayFmt(s.start))}</text>` : ''}`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${label}, mood by week: ${series.map((s) => pts(s.mood)).join(', ')}`)}">
      ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${(mid - v * k).toFixed(1)}" y2="${(mid - v * k).toFixed(1)}"/><text x="${L - 6}" y="${(mid - v * k).toFixed(1)}" dy="0.32em" text-anchor="end">${v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'}</text></g>`).join('')}
      <line class="mo-zero" x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}"/>${bars}</svg>`;
  }

  // Each company: a dot for the last 90 days, a line from the 90 before.
  function companies(d, narrow) {
    const list = d.companies;
    const vals = list.flatMap((c) => [c.mood90, c.moodPrev]).filter((v) => v != null);
    const m = Math.max(10, ...vals.map(Math.abs));
    const top = Math.ceil(m / 10) * 10;
    const W = narrow ? 360 : 560, LW = narrow ? 92 : 120, R = 50, RH = 26, T = 18;
    const H = T + list.length * RH + 4;
    const x = (v) => LW + ((v + top) / (2 * top)) * (W - LW - R);
    const rows = list.map((c, i) => {
      const y = T + i * RH + RH / 2;
      const on = view.c === c.key;
      const from = c.moodPrev != null ? `<line class="mo-arrow" x1="${x(c.moodPrev).toFixed(1)}" x2="${x(c.mood90).toFixed(1)}" y1="${y}" y2="${y}"/><circle class="mo-prev" cx="${x(c.moodPrev).toFixed(1)}" cy="${y}" r="3.5"/>` : '';
      return `<a href="#mood${on ? '' : `?c=${c.key}`}" class="mo-co${on ? ' on' : ''}${view.c && !on ? ' dim' : ''}" data-c="${c.key}" style="--i:${i}">
        <text class="mo-cl" x="${LW - 10}" y="${y}" dy="0.32em" text-anchor="end">${esc(c.label)}</text>
        ${from}<circle class="mo-now ${c.mood90 >= 0 ? 'good' : 'bad'}" cx="${x(c.mood90).toFixed(1)}" cy="${y}" r="6"/>
        <text class="mo-cv" x="${W - R + 8}" y="${y}" dy="0.32em">${esc(pts(c.mood90))}</text>
        <rect class="mo-hit" x="0" y="${y - RH / 2}" width="${W}" height="${RH}"/></a>`;
    }).join('');
    return `<section class="mo-cos"><h2 class="when">Companies<span>last 90 days (dot) against the 90 before (ring); tap one for its weeks and headlines</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(list.map((c) => `${c.label}: ${pts(c.mood90)}, was ${pts(c.moodPrev)}`).join('; '))}">
        ${[-top, -top / 2, 0, top / 2, top].map((v) => `<g class="lc-tick${v === 0 ? ' zero' : ''}"><line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${T - 4}" y2="${H - 2}"/><text x="${x(v).toFixed(1)}" y="${T - 8}" text-anchor="middle">${v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'}</text></g>`).join('')}
        ${rows}
      </svg></section>`;
  }

  function company(d, narrow) {
    const c = d.companies.find((x) => x.key === view.c);
    if (!c) return '';
    const series = c.weeks.map((v, i) => ({ start: d.series[i]?.start, mood: v }));
    const list = (items, cls) => (items.length ? `<ol class="mo-hl ${cls}">${items.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><small>${esc(h.source)} · ${h.words.map((w) => `<b>${esc(w)}</b>`).join(' ')}</small></li>`).join('')}</ol>` : '<p class="rail-note">None this week.</p>');
    return `<section class="mo-detail" id="mood-co"><h2 class="when">${esc(c.label)}<span>${plural(c.n90, 'headline')} in 90 days · ${esc(pts(c.mood90))} points · this week ${esc(pts(c.moodWeek))}</span><a class="tl-clear" href="#mood">Close</a></h2>
      ${weeks(series, narrow, { H: 150, label: c.label })}
      <div class="mo-two"><div><h3 class="mo-h good">Good news this week</h3>${list(c.good, 'good')}</div><div><h3 class="mo-h bad">Bad news this week</h3>${list(c.bad, 'bad')}</div></div></section>`;
  }

  function outlets(d) {
    const row = (o, max) => `<li><span class="mo-on">${esc(o.name)}</span><span class="mo-ob"><i class="${o.mood >= 0 ? 'mo-good-bg' : 'mo-bad-bg'}" style="width:${((Math.abs(o.mood) / max) * 100).toFixed(1)}%"></i></span><small>${esc(pts(o.mood))}</small></li>`;
    const max = Math.max(10, ...[...d.outlets.warmest, ...d.outlets.coolest].map((o) => Math.abs(o.mood)));
    return `<section class="mo-outlets"><h2 class="when">Outlets<span>points of good news minus bad in their AI headlines, last 90 days, of ${d.outlets.count} with 40 or more</span></h2>
      <div class="mo-two"><div><h3 class="mo-h good">Warmest</h3><ol>${d.outlets.warmest.map((o) => row(o, max)).join('')}</ol></div>
      <div><h3 class="mo-h bad">Coolest</h3><ol>${d.outlets.coolest.map((o) => row(o, max)).join('')}</ol></div></div></section>`;
  }

  function words(d) {
    const cloud = (list, cls) => {
      const max = Math.max(1, ...list.map((w) => w.n));
      return `<p class="mo-words ${cls}">${list.map((w, i) => `<span style="--s:${(0.8 + (w.n / max) * 0.7).toFixed(2)};--i:${i}" title="${w.n} this week, ${w.prev} the week before">${esc(w.w)}<small>${w.n}</small></span>`).join('')}</p>`;
    };
    return `<section class="mo-wordsec"><h2 class="when">This week’s words<span>what made headlines read good or bad in the last seven days</span></h2>
      <div class="mo-two"><div><h3 class="mo-h good">Good</h3>${cloud(d.words.good, 'good')}</div><div><h3 class="mo-h bad">Bad</h3>${cloud(d.words.bad, 'bad')}</div></div></section>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const s = d.stats;
    return `<div class="tl-stats">
        <p><b>${esc(pts(s.mood90))}</b><span>points of good news minus bad in AI headlines, last 90 days (${esc(pts(s.moodPrev))} the 90 before)</span></p>
        <p><b>${esc(pts(s.moodWeek))}</b><span>this week, ${esc(pts(s.moodLastWeek))} the week before</span></p>
        ${s.share90 ? `<p><b>${Math.round(s.share90.pos * 100)}% · ${Math.round(s.share90.neg * 100)}%</b><span>of headlines read good · bad; the rest neither</span></p>` : ''}
        <p><b>${(s.headlines90 / 1000).toFixed(1)}K</b><span>AI headlines scored in 90 days</span></p>
      </div>
      <section class="mo-main"><h2 class="when">Week by week<span>good news above the line, bad below; each bar a week ending on the date shown</span></h2>
        <ul class="tr-legend"><li style="--c:var(--mo-good)"><i class="sw"></i>More good than bad</li><li style="--c:var(--mo-bad)"><i class="sw"></i>More bad than good</li></ul>
        ${weeks(d.series.map((x) => ({ ...x, start: x.start + 7 * DAY - 1 })), narrow)}</section>
      ${company(d, narrow)}
      <div class="mo-grid">${companies(d, narrow)}${words(d)}</div>
      ${outlets(d)}
      <section class="mo-week"><h2 class="when">The week in two columns<span>the strongest-worded good and bad AI headlines of the last seven days</span></h2>
        <div class="mo-two"><div><h3 class="mo-h good">Good</h3><ol class="mo-hl good">${d.week.good.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><small>${esc(h.source)} · ${h.words.map((w) => `<b>${esc(w)}</b>`).join(' ')}</small></li>`).join('')}</ol></div>
        <div><h3 class="mo-h bad">Bad</h3><ol class="mo-hl bad">${d.week.bad.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><small>${esc(h.source)} · ${h.words.map((w) => `<b>${esc(w)}</b>`).join(' ')}</small></li>`).join('')}</ol></div></div></section>
      <p class="rail-note">From ${d.headlines.toLocaleString('en')} English AI headlines over ${d.weeks} weeks, each copy counted once. A headline reads good or bad by its evaluative words (a record, a breakthrough; a lawsuit, a breach), not by its subject, so a launch is neither; “not” and “without” flip the word after them. Mood is the share of good headlines minus the share of bad, in points. A word list misses sarcasm and context, so read single headlines with care and trends with more confidence. How outlets word the same story is on <a href="#framing">Framing</a>. <a href="/api/mood">JSON</a></p>
      <div class="ac-tip mo-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#moodView');
    document.title = `The mood of AI news · ${site}`;
    const head = `<header class="topic-head mo-head"><p class="kicker">Mood</p><h1>The mood of AI news</h1>
      <p class="topic-sum">Is the news about AI getting better or worse? Every headline read for good and bad news, week by week, company by company, outlet by outlet.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The mood needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="mo-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.c && opened !== view.c) {
      // After the router's scroll to the top.
      requestAnimationFrame(() => $('#mood-co')?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
    opened = view.c;
  }

  function hover(e) {
    const tip = $('#moodView .mo-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const wk = t?.closest?.('.mo-wk');
    const co = t?.closest?.('.mo-co');
    let html = '';
    let el = null;
    if (wk && !wk.closest('.mo-detail')) {
      const s = d.series[+wk.dataset.i];
      if (s) {
        el = wk;
        html = `<p class="tt-h">Week to ${esc(dayFmt(s.start + 7 * DAY - 1))}</p><p><b>${esc(pts(s.mood))}</b> points · ${plural(s.n, 'headline')}</p><p>${s.n ? Math.round((100 * s.pos) / s.n) : 0}% good · ${s.n ? Math.round((100 * s.neg) / s.n) : 0}% bad</p>`;
      }
    } else if (wk) {
      const c = d.companies.find((x) => x.key === view.c);
      const v = c?.weeks[+wk.dataset.i];
      if (c) {
        el = wk;
        html = `<p class="tt-h">${esc(c.label)}, week to ${esc(dayFmt(d.series[+wk.dataset.i].start + 7 * DAY - 1))}</p><p><b>${esc(pts(v))}</b> points${v == null ? ' (too few headlines)' : ''}</p>`;
      }
    } else if (co) {
      const c = d.companies.find((x) => x.key === co.dataset.c);
      if (c) {
        el = co.querySelector('.mo-now');
        html = `<p class="tt-h">${esc(c.label)}</p><p><b>${esc(pts(c.mood90))}</b> points in 90 days (${plural(c.n90, 'headline')})</p><p>The 90 before: ${esc(pts(c.moodPrev))} · this week: ${esc(pts(c.moodWeek))}</p>`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#moodView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
