// Ask the Wire (#ask?q=…): a question answered with sentences from stored
// coverage, each citing its article. Nothing is generated; the answer is only
// as good as what was reported. Recent questions stay in this browser.
// Server side: src/index/ask.js.

const EXAMPLES = [
  'Why did Nvidia buy Hugging Face?',
  'What is the EU AI Act code of practice?',
  'How much did Anthropic raise in its latest round?',
  'Is DeepSeek V4 open weights?',
  'What did Jensen Huang say about China?',
  'What is the Model Context Protocol?',
];
const CONF = {
  strong: ['good', 'Well covered', 'These sentences answer it closely.'],
  partial: ['warn', 'Partly covered', 'Related coverage; it may not answer every part.'],
  weak: ['bad', 'Closest matches', 'Nothing answers this directly; these are the nearest sentences.'],
};
const ICONS = {
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8"/><path d="m4.5 8.2 2.3 2.3 4.7-4.9" fill="none" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .8 15.4 14.5H.6z"/><path d="M8 5.5v4.2M8 11.6v.4" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8"/><path d="M5 8h6" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
// Questions, not keyword searches: "why…", "what is…", or a question mark.
export const looksLikeQuestion = (q) => /\?\s*$/.test(q) || /^(?:who|what|when|where|why|how|which|is|are|was|were|did|does|do|can|could|will|should|has|have)\b/i.test(String(q).trim());

export function createAsk({ $, esc, setHtml, state, reducedMotion, store }) {
  const view = { q: '' };
  const answers = new Map(); // question -> { d, error, pending, at }
  let shown = null;
  let recent = (store.get('fw.asked', []) || []).filter((x) => typeof x === 'string').slice(0, 6);

  const href = (q) => `#ask${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  const day = (t) => (t ? new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

  function route(hash) {
    const m = /^#ask(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.q = (new URLSearchParams(m[1] || '').get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return 'ask';
  }

  async function load(q) {
    const hit = answers.get(q);
    if (hit?.pending || hit?.d || (hit?.error && Date.now() - hit.at < 15e3)) return;
    answers.set(q, { pending: true });
    try {
      const r = await fetch(`/api/ask?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      answers.set(q, { d, at: Date.now() });
      if (answers.size > 40) answers.delete(answers.keys().next().value);
      recent = [q, ...recent.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
      store.set('fw.asked', recent);
    } catch (err) {
      answers.set(q, { error: err.message, at: Date.now() });
    }
    if (state.view === 'ask' && view.q === q) render();
  }

  function answer(d) {
    if (!d.answer.length) {
      return `<section class="ak-answer ak-none" aria-live="polite"><p>Nothing in the coverage answers that.</p><p class="rail-note">Try naming the company, model or person, or <a href="#search?q=${encodeURIComponent(d.terms.join(' ') || d.q)}">search every article</a>.</p></section>`;
    }
    const [cls, label, note] = CONF[d.confidence] || CONF.weak;
    const src = new Map(d.sources.map((s) => [s.n, s]));
    const lines = d.answer.map((a, i) => {
      const s = src.get(a.cite);
      return `<li style="--i:${i}"><p>${esc(a.text)} <a class="ak-cite" href="${esc(s.url)}" target="_blank" rel="noopener" data-akcite="${a.cite}" aria-label="Source ${a.cite}: ${esc(s.title)}">${a.cite}</a></p><small>${esc(s.source || s.site)} · ${day(s.at)}</small></li>`;
    }).join('');
    const cited = d.sources.filter((s) => s.cited).length;
    return `<section class="ak-answer" aria-live="polite">
      <div class="ak-meta"><span class="ak-conf ${cls}" title="${note}">${ICONS[cls]}${label}</span><small>From ${cited} ${cited === 1 ? 'article' : 'articles'} · ${(d.tookMs / 1000).toFixed(1)} s</small></div>
      <ol class="ak-lines">${lines}</ol>
      <p class="ak-note">Sentences quoted from the coverage, not written by a model. Read the sources for context.</p>
    </section>`;
  }

  function sources(d) {
    if (!d.sources.length) return '';
    return `<section class="ak-sources"><h2 class="when">Sources<span>${d.sources.length}</span></h2><ol>${d.sources.map((s) => `<li id="ak-src-${s.n}" class="${s.cited ? 'cited' : ''}" style="--n:${s.n}"><span class="ak-n">${s.n}</span><div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><small>${esc(s.source || s.site)} · ${day(s.at)}${s.cited ? '' : ' · related'}</small></div></li>`).join('')}</ol>
      <p class="ak-more"><a class="tr-link" href="#search?q=${encodeURIComponent(d.terms.join(' ') || d.q)}">Search every article →</a>${d.terms.length && d.terms.length <= 3 ? ` <a class="tr-link" href="#trends?q=${encodeURIComponent(d.terms.join(' '))}">How often it comes up →</a>` : ''}</p></section>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `${view.q ? `${view.q} · ` : ''}Ask the Wire · ${name}`;
    const head = `<header class="topic-head ak-head">
        <p class="kicker">Search</p>
        <h1>Ask the Wire</h1>
        <p class="topic-sum">Ask anything about AI. The answer is made of sentences from about 200,000 stored articles, each linked to its source.</p>
      </header>
      <form class="tr-form ak-form" data-akform role="search">
        <label class="visually-hidden" for="akInput">Your question</label>
        <input id="akInput" name="q" type="search" autocomplete="off" maxlength="200" placeholder="e.g. Why did Nvidia buy Hugging Face?" value="${esc(view.q)}">
        <button class="btn" type="submit">Ask</button>
      </form>`;
    if (state.mode !== 'api') {
      setHtml($('#askView'), `${head}<p class="rail-note">Answers need the live server.</p>`);
      return;
    }
    if (!view.q) {
      shown = null;
      const ex = (title, qs) => `<section class="ak-ex"><h2 class="when">${title}</h2><ul>${qs.map((q, i) => `<li style="--i:${i}"><a href="${href(q)}">${esc(q)}</a></li>`).join('')}</ul></section>`;
      setHtml($('#askView'), `${head}${recent.length ? ex('You asked', recent) : ''}${ex('Try', EXAMPLES)}`);
      return;
    }
    load(view.q);
    const hit = answers.get(view.q);
    if (!hit?.d) {
      setHtml($('#askView'), `${head}${hit?.error ? `<p class="rail-note">Answers are unavailable: ${esc(hit.error)}</p>` : `<section class="ak-answer ak-loading" aria-busy="true" aria-label="Finding an answer"><p class="ak-wait">Reading the coverage…</p>${[92, 84, 96, 70].map((w) => `<i class="skeleton" style="width:${w}%"></i>`).join('')}</section>`}`);
      return;
    }
    const d = hit.d;
    const fresh = shown !== d && !reducedMotion();
    shown = d;
    setHtml($('#askView'), `${head}<div class="ak-body${fresh ? ' reveal' : ''}">${answer(d)}${sources(d)}</div>`);
  }

  function onSubmit(e) {
    if (!e.target.matches?.('[data-akform]')) return false;
    e.preventDefault();
    const q = e.target.q.value.replace(/\s+/g, ' ').trim();
    if (q.length >= 3) location.hash = href(q);
    return true;
  }

  // Pointing at a citation lights up its source.
  function hover(e) {
    const cite = e.target.closest?.('[data-akcite]');
    for (const li of document.querySelectorAll('#askView .ak-sources li.lit')) li.classList.remove('lit');
    if (cite && e.type !== 'pointerleave') $(`#ak-src-${cite.dataset.akcite}`)?.classList.add('lit');
  }

  return { route, render, onSubmit, hover, href };
}
