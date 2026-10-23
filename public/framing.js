// Framing (#framing?s=<story>): how outlets headline the same story. The
// last two days' stories told by four or more outlets, the most divided
// first; opening one lines up every outlet's headline with the words only it
// chose marked, its tone (good, bad or neither, with the words behind it)
// and its shape (question, quote, number, explainer), under the words most
// of them share. Outlets that read darker or brighter than the others on the
// same stories close the page. Server side: src/index/framing.js.

const timeFmt = (t) => new Date(t).toLocaleString('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const SHAPE = { question: 'Question', quote: 'Quote', number: 'Number', explainer: 'Explainer', scoop: 'Scoop' };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createFraming({ $, esc, setHtml, state, reducedMotion }) {
  const view = { s: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let opened = '';

  function route(hash) {
    const m = /^#framing(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.s = (new URLSearchParams(m[1] || '').get('s') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    return 'framing';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 10 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/framing');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'framing') render();
  }

  // The headline with the words only this outlet used marked.
  function marked(h) {
    let html = esc(h.title);
    for (const w of h.only) html = html.replace(new RegExp(`(^|[^\\w>])(${escRe(esc(w))})(?![\\w<])`, 'i'), '$1<mark>$2</mark>');
    return html;
  }

  const toneMark = (h) => (h.tone > 0 ? `<span class="fr-tone good" title="Reads as good news: ${esc(h.pos.join(', '))}">Good</span>` : h.tone < 0 ? `<span class="fr-tone bad" title="Reads as bad news: ${esc(h.neg.join(', '))}">Bad</span>` : '');

  // Spread as a short meter: how differently the outlets worded it.
  const meter = (s) => `<span class="fr-meter" title="${Math.round(s.spread * 100)}% different wording on average"><i style="width:${Math.round(s.spread * 100)}%"></i></span>`;

  function storyCard(s, i, divided) {
    const open = view.s === s.id;
    const tones = { good: s.headlines.filter((h) => h.tone > 0).length, bad: s.headlines.filter((h) => h.tone < 0).length };
    return `<li class="fr-story${divided ? ' divided' : ''}" id="fr-${esc(s.id)}" style="--i:${Math.min(i, 14)}">
      <details${open ? ' open' : ''}>
        <summary>
          <p class="ct-meta"><span class="fr-n">${s.outlets} outlets</span>${meter(s)}<span class="fr-spread">${Math.round(s.spread * 100)}% different words</span>${tones.good ? `<span class="fr-tone good">${tones.good} good</span>` : ''}${tones.bad ? `<span class="fr-tone bad">${tones.bad} bad</span>` : ''}</p>
          <h3>${esc(s.title)}</h3>
          <p class="ct-sub">First: ${esc(s.first.source)}, ${esc(timeFmt(s.first.at))}${s.core.length ? ` · most say <span class="fr-core">${s.core.slice(0, 6).map((w) => `<b>${esc(w)}</b>`).join(' ')}</span>` : ''}</p>
        </summary>
        <ol class="fr-heads">${s.headlines.map((h, j) => `<li style="--i:${j}">
          <p class="fr-src"><img src="${esc(fav(hostOf(h.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove">${esc(h.source)}<time>${esc(timeFmt(h.at))}</time></p>
          <p class="fr-h"><a href="${esc(h.url)}" target="_blank" rel="noopener">${marked(h)}</a></p>
          <p class="fr-tags">${toneMark(h)}${h.shape.map((k) => `<span class="fr-shape">${esc(SHAPE[k] || k)}</span>`).join('')}${h.only.length ? `<span class="fr-only">own words: ${h.only.map(esc).join(', ')}</span>` : '<span class="fr-only">no words of its own</span>'}</p>
        </li>`).join('')}</ol>
      </details></li>`;
  }

  function outlets(d) {
    const max = Math.max(0.2, ...[...d.outlets.darker, ...d.outlets.brighter].map((o) => Math.abs(o.diff)));
    const row = (o) => `<li><span class="fr-on">${esc(o.name)}</span><span class="fr-ob"><i class="${o.diff >= 0 ? 'good' : 'bad'}" style="width:${((Math.abs(o.diff) / max) * 100).toFixed(1)}%"></i></span><small>${o.diff > 0 ? '+' : '−'}${Math.abs(o.diff).toFixed(2)} · ${o.n}</small></li>`;
    if (!d.outlets.darker.length && !d.outlets.brighter.length) return '';
    return `<section class="fr-outlets"><h2 class="when">Against the pack<span>each outlet’s headline tone minus the other outlets’ on the same stories (−1 to +1), with how many stories; ${d.outlets.count} outlets with four or more</span></h2>
      <div class="mo-two"><div><h3 class="mo-h bad">Darker than the rest</h3><ol>${d.outlets.darker.map(row).join('')}</ol></div>
      <div><h3 class="mo-h good">Brighter than the rest</h3><ol>${d.outlets.brighter.map(row).join('')}</ol></div></div></section>`;
  }

  function page(d) {
    const s = d.stats;
    const divided = d.divided.map((id) => d.stories.find((x) => x.id === id)).filter(Boolean);
    const rest = d.stories.filter((x) => !d.divided.includes(x.id));
    return `<div class="tl-stats">
        <p><b>${s.stories}</b><span>stories told by four or more outlets in ${d.hours} hours</span></p>
        <p><b>${s.outletsPerStory}</b><span>outlets per story on average</span></p>
        <p><b>${Math.round(s.spread * 100)}%</b><span>different words between two outlets’ headlines on the same story, on average</span></p>
        <p><b>${s.split}</b><span>stories where one outlet’s headline reads good and another’s bad</span></p>
      </div>
      ${divided.length ? `<section><h2 class="when">Told most differently<span>the widest spread of tone, then of wording; open one to line them up</span></h2><ol class="fr-list">${divided.map((x, i) => storyCard(x, i, true)).join('')}</ol></section>` : ''}
      <section><h2 class="when">Every story<span>by how many outlets ran it</span></h2><ol class="fr-list">${rest.map((x, i) => storyCard(x, i, false)).join('') || '<li class="rail-note">No stories with four or more outlets right now.</li>'}</ol></section>
      ${outlets(d)}
      <p class="rail-note">From ${d.headlines.toLocaleString('en')} English headlines in the last ${d.hours} hours, grouped into stories by meaning (sentence embeddings) among headlines that share words, one headline per outlet. Marked words are ones no other outlet used for that story. Tone is read from evaluative words (see <a href="#mood">Mood</a>), so a dry headline is neither good nor bad. <a href="/api/framing">JSON</a></p>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#framingView');
    document.title = `Framing · ${site}`;
    const head = `<header class="topic-head fr-head"><p class="kicker">Framing</p><h1>Same story, different headlines</h1>
      <p class="topic-sum">How each outlet tells the day’s AI stories: the words only they chose, whether it reads as good or bad news, and who runs darker than the rest.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Framing needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="fr-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.s && opened !== view.s) {
      // After the router's scroll to the top.
      requestAnimationFrame(() => document.getElementById(`fr-${view.s}`)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
    opened = view.s;
  }

  return { route, render };
}
