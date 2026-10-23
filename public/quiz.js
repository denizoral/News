// The week in AI quiz (#quiz, #quiz?w=<edition>): one question at a time
// from the week that ended last Saturday. Answering shows the right option,
// how readers split and the story behind it; the end shows your score
// against everyone who finished, a review, and a shareable grid. Answers and
// scores are kept in this browser; the server only counts picks. Server
// side: src/index/quiz.js and src/index/quizbook.js.

const KEY = 'fw.quiz.';
const dayFmt = (t, o = {}) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC', ...o });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pct = (n, of) => (of ? Math.round((100 * n) / of) : 0);

export function createQuiz({ $, esc, setHtml, state, reducedMotion }) {
  const view = { w: '' };
  const cache = new Map(); // edition -> { d, error, at, pending }
  const stats = new Map(); // edition -> stats once finished
  let copied = 0;
  let busy = false;

  const read = (id) => {
    try { return JSON.parse(localStorage.getItem(KEY + id)) || { answers: {} }; } catch { return { answers: {} }; }
  };
  const write = (id, v) => {
    try { localStorage.setItem(KEY + id, JSON.stringify(v)); } catch {}
  };

  function route(hash) {
    const m = /^#quiz(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const w = new URLSearchParams(m[1] || '').get('w') || '';
    view.w = /^\d{4}-\d\d-\d\d$/.test(w) ? w : '';
    return 'quiz';
  }

  async function load(id) {
    const key = id || 'latest';
    const c = cache.get(key);
    if (c?.pending || (c?.d && Date.now() - c.at < 10 * 60e3) || (c?.error && Date.now() - c.at < 20e3)) return;
    cache.set(key, { ...c, pending: true });
    try {
      const r = await fetch(`/api/quiz${id ? `?edition=${encodeURIComponent(id)}` : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(key, { d, at: Date.now() });
      cache.set(d.id, { d, at: Date.now() });
    } catch (err) {
      cache.set(key, { d: c?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'quiz') render();
  }

  async function loadStats(id) {
    if (stats.get(id)?.pending) return;
    stats.set(id, { ...stats.get(id), pending: true });
    try {
      const r = await fetch(`/api/quiz/stats?edition=${encodeURIComponent(id)}`);
      const s = await r.json();
      if (!r.ok) throw new Error(s.error);
      stats.set(id, s);
    } catch {
      stats.set(id, { failed: true });
    }
    if (state.view === 'quiz') render();
  }

  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });

  function weekLabel(d) {
    return `${dayFmt(d.from, { weekday: 'short' })} to ${dayFmt(d.to - 1, { weekday: 'short' })}`;
  }

  // Each option's share of readers, as a bar behind it.
  function options(q, a) {
    const total = a?.picks?.reduce((x, y) => x + y, 0) || 0;
    return `<ol class="qz-opts${a ? ' done' : ''}">${q.options.map((o, i) => {
      const cls = a ? (i === a.answer ? ' right' : i === a.choice ? ' wrong' : ' rest') : '';
      const mark = a ? (i === a.answer ? '<span class="qz-mark" aria-label="Right answer">✓</span>' : i === a.choice ? '<span class="qz-mark" aria-label="Your answer, wrong">✗</span>' : '') : '';
      const share = a ? pct(a.picks?.[i] || 0, total) : 0;
      return `<li style="--i:${i}"><button type="button" class="qz-opt${cls}" data-qopt="${i}"${a || busy ? ' disabled' : ''}>
        ${a ? `<span class="qz-share" style="width:${share}%"></span>` : ''}<span class="qz-ol">${esc(o)}</span>${mark}${a ? `<small>${share}%</small>` : ''}</button></li>`;
    }).join('')}</ol>`;
  }

  function reveal(q, a) {
    const total = a.picks?.reduce((x, y) => x + y, 0) || 0;
    const right = pct(a.picks?.[a.answer] || 0, total);
    const src = a.market
      ? `<p class="qz-src">Polymarket went from <b>${a.market.start}%</b> to <b>${a.market.end}%</b> · <a href="${esc(a.market.url)}" target="_blank" rel="noopener">See the market</a></p>`
      : a.story ? `<p class="qz-src"><a href="${esc(a.story.url)}" target="_blank" rel="noopener">${esc(a.story.title)}</a> <small>${esc(a.story.source || '')}${a.story.sources > 1 ? ` · ${a.story.sources} outlets` : ''}</small></p>` : '';
    return `<div class="qz-reveal"><p class="qz-verdict ${a.correct ? 'right' : 'wrong'}"><span aria-hidden="true">${a.correct ? '✓' : '✗'}</span>${a.correct ? 'Right' : `The answer is ${esc(q.options[a.answer])}`}<small>${total > 1 ? `${right}% of ${total} readers got this` : 'You’re the first to answer'}</small></p>${src}</div>`;
  }

  function progress(d, mine, at) {
    return `<ol class="qz-prog" aria-label="Progress">${d.questions.map((q, i) => {
      const a = mine.answers[q.n];
      return `<li class="${a ? (a.correct ? 'right' : 'wrong') : i === at ? 'now' : ''}" title="Question ${i + 1}${a ? (a.correct ? ': right' : ': wrong') : ''}"></li>`;
    }).join('')}</ol>`;
  }

  function question(d, mine) {
    // The question just answered stays up until Next, then the first unanswered.
    const q = d.questions.find((x) => mine.answers[x.n] && !mine.answers[x.n].seen) || d.questions.find((x) => !mine.answers[x.n]) || d.questions.at(-1);
    const a = mine.answers[q.n];
    const idx = d.questions.indexOf(q);
    const text = esc(q.text).replace(/(\$?)_____/g, (m, s) => `<span class="qz-blank">${s}<i></i></span>`);
    return `${progress(d, mine, idx)}
      <article class="qz-card" data-q="${q.n}" style="view-transition-name:qz-card">
        <p class="qz-k">Question ${idx + 1} of ${d.questions.length} · ${esc(q.prompt)}</p>
        <h2 class="qz-text${q.type === 'market' ? ' market' : ''}">${text}</h2>
        ${options(q, a)}
        ${a ? reveal(q, a) : ''}
        ${a ? `<p class="qz-next"><button type="button" class="qz-btn qz-go" data-qnext>${idx === d.questions.length - 1 ? 'See your score' : 'Next question'} <span aria-hidden="true">→</span></button></p>` : ''}
      </article>`;
  }

  // Readers' scores as columns, yours marked.
  function histogram(hist, score) {
    const total = hist.reduce((a, b) => a + b, 0);
    if (!total) return '';
    const max = Math.max(...hist);
    const W = 360, H = 120, B = 18, T = 14;
    const bw = W / hist.length;
    const below = hist.slice(0, score).reduce((a, b) => a + b, 0);
    return `<section class="qz-hist"><h2 class="when">How readers did<span>${plural(total, 'reader')} finished this week</span></h2>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(hist.map((n, s) => `${s} right: ${n}`).join('; '))}">
        ${hist.map((n, s) => {
          const h = max ? (n / max) * (H - B - T) : 0;
          return `<g class="qz-col${s === score ? ' you' : ''}" style="--i:${s}"><rect x="${(s * bw + bw * 0.15).toFixed(1)}" y="${(H - B - Math.max(1, h)).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3"/>
            ${s === score ? `<text class="qz-you" x="${(s * bw + bw / 2).toFixed(1)}" y="${(H - B - Math.max(1, h) - 4).toFixed(1)}" text-anchor="middle">you</text>` : ''}
            <text class="lc-xt" x="${(s * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${s}</text></g>`;
        }).join('')}
      </svg>
      <p class="qz-beat">${total > 1 ? `You did better than <b>${pct(below, total)}%</b> of readers.` : 'You’re the first to finish this week.'}</p></section>`;
  }

  const grid = (d, mine) => d.questions.map((q) => (mine.answers[q.n]?.correct ? '🟩' : '🟥')).join('');

  function finished(d, mine) {
    const score = d.questions.filter((q) => mine.answers[q.n]?.correct).length;
    const s = stats.get(d.id);
    if (!s || (!s.hist && !s.pending && !s.failed)) loadStats(d.id);
    const hist = s?.hist || null;
    const review = d.questions.map((q, i) => {
      const a = mine.answers[q.n] || {};
      const fresh = s?.questions?.[i];
      const story = a.story || fresh?.story;
      const market = a.market || fresh?.market;
      const answer = a.answer ?? fresh?.answer;
      return `<li class="${a.correct ? 'right' : 'wrong'}" style="--i:${i}"><span class="qz-rm" aria-label="${a.correct ? 'Right' : 'Wrong'}">${a.correct ? '✓' : '✗'}</span>
        <div><p class="qz-rq">${esc(q.text).replace(/(\$?)_____/g, (m, sym) => `<b>${sym}${esc(String(q.options[answer] ?? '?').replace(/^\$/, ''))}</b>`)}</p>
        <p class="qz-rs">${a.correct ? '' : `You said ${esc(q.options[a.choice] ?? '—')} · `}${market ? `<a href="${esc(market.url)}" target="_blank" rel="noopener">Polymarket: ${market.start}% → ${market.end}%</a>` : story ? `<a href="${esc(story.url)}" target="_blank" rel="noopener">${esc(story.source || 'Read the story')}</a>` : ''}</p></div></li>`;
    }).join('');
    const msg = score === d.questions.length ? 'A perfect week.' : score >= d.questions.length * 0.7 ? 'You follow the news closely.' : score >= d.questions.length * 0.4 ? 'Not bad at all.' : 'A busy week. Catch up below.';
    return `${progress(d, mine, -1)}
      <section class="qz-end">
        <p class="qz-score"><b>${score}</b><span>/ ${d.questions.length}</span></p>
        <p class="qz-msg">${esc(msg)}</p>
        <p class="qz-grid" aria-label="Your answers">${grid(d, mine)}</p>
        <p class="qz-acts"><button type="button" class="qz-btn" data-qshare>${Date.now() - copied < 2500 ? 'Copied' : 'Copy your result'}</button><a class="qz-btn ghost" href="#week">This week’s stories</a></p>
      </section>
      ${hist ? histogram(hist, score) : s?.failed ? '' : '<i class="skeleton" style="height:120px;display:block;margin:16px 0;border-radius:12px"></i>'}
      <section class="qz-review"><h2 class="when">The answers<span>with the stories behind them</span></h2><ol>${review}</ol></section>`;
  }

  function editions(d) {
    return `<nav class="pd-chips qz-eds" aria-label="Weeks">${d.editions.map((e, i) => {
      const mine = read(e.id);
      const n = Object.values(mine.answers || {}).length;
      const score = mine.done ? Object.values(mine.answers).filter((a) => a.correct).length : null;
      return `<a class="chip${e.id === d.id ? ' on' : ''}" href="${i === 0 ? '#quiz' : `#quiz?w=${esc(e.id)}`}">${i === 0 ? 'This week' : esc(`Week to ${dayFmt(e.to - 1)}`)}${score != null ? ` <small>${score} right</small>` : n ? ' <small>started</small>' : ''}</a>`;
    }).join('')}</nav>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#quizView');
    document.title = `The week in AI quiz · ${site}`;
    const c = cache.get(view.w || 'latest');
    const d = c?.d;
    const head = `<header class="topic-head qz-head"><p class="kicker">Quiz</p><h1>The week in AI</h1>
      <p class="topic-sum">${d ? `${esc(weekLabel(d))}: ` : ''}${d ? plural(d.questions.length, 'question') : 'Questions'} from the stories the most outlets ran, the week’s big numbers and the prediction markets that moved. A new quiz every Saturday.${d?.players ? ` ${plural(d.players, 'reader')} played.` : ''}</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The quiz needs the live server.</p>`);
      return;
    }
    load(view.w);
    if (!d) {
      setHtml(host, `${head}${c?.error ? `<p class="rail-note">${esc(c.error)}</p>` : '<i class="skeleton" style="height:360px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const mine = read(d.id);
    let body;
    if (d.questions.length < 3) body = '<p class="rail-note">There wasn’t enough news stored for this week to make a quiz. Try another week.</p>';
    else body = mine.done ? finished(d, mine) : question(d, mine);
    setHtml(host, `${head}${editions(d)}<div class="qz-page${reducedMotion() ? '' : ' animate'}">${body}</div>
      <p class="rail-note">Questions come from the week’s English AI headlines, grouped by story and ranked by how many outlets ran them; wrong options are names or amounts of the same kind from the same week. Your answers stay in this browser; the site only counts how many readers picked each option. <a href="/api/quiz">JSON</a></p>`);
  }

  function swap(fn) {
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(fn);
    else fn();
  }

  async function answer(btn) {
    const c = cache.get(view.w || 'latest');
    const d = c?.d;
    const card = btn.closest('.qz-card');
    if (!d || !card || busy) return;
    const n = +card.dataset.q;
    const choice = +btn.dataset.qopt;
    const mine = read(d.id);
    if (mine.answers[n]) return;
    busy = true;
    btn.classList.add('picked');
    try {
      const r = await post('/api/quiz/answer', { edition: d.id, n, choice });
      mine.answers[n] = { n, choice, correct: r.correct, answer: r.answer, story: r.story, market: r.market, picks: r.picks };
      write(d.id, mine);
    } catch (err) {
      btn.classList.remove('picked');
      setHtml(card.querySelector('.qz-k'), `${esc(err.message)} Try again.`);
    }
    busy = false;
    render();
  }

  async function next() {
    const c = cache.get(view.w || 'latest');
    const d = c?.d;
    if (!d) return;
    const mine = read(d.id);
    for (const a of Object.values(mine.answers)) a.seen = true;
    const left = d.questions.some((q) => !mine.answers[q.n]);
    if (!left && !mine.done) {
      mine.done = true;
      const score = d.questions.filter((q) => mine.answers[q.n]?.correct).length;
      write(d.id, mine);
      try {
        const s = await post('/api/quiz/score', { edition: d.id, score });
        stats.set(d.id, s);
      } catch {}
    } else {
      write(d.id, mine);
    }
    swap(() => {
      render();
      $('#quizView .qz-prog')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    });
  }

  function onClick(e) {
    const opt = e.target.closest('[data-qopt]');
    if (opt) return answer(opt);
    if (e.target.closest('[data-qnext]')) return next();
    if (e.target.closest('[data-qshare]')) {
      const d = cache.get(view.w || 'latest')?.d;
      if (!d) return;
      const mine = read(d.id);
      const score = d.questions.filter((q) => mine.answers[q.n]?.correct).length;
      const text = `The week in AI quiz (${weekLabel(d)}): ${score}/${d.questions.length}\n${grid(d, mine)}\n${location.origin}/#quiz${view.w ? `?w=${view.w}` : ''}`;
      navigator.clipboard?.writeText(text).then(() => { copied = Date.now(); render(); setTimeout(render, 2600); }).catch(() => {});
    }
  }

  return { route, render, onClick };
}
