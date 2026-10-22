// API and feeds (#developers): a feed builder with a live preview, and every
// public endpoint (from /api, src/apicatalog.js) with a "Try it" that shows
// the real response. Also the Feed button other pages carry.

const RSS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="12.5" r="1.6" fill="currentColor"/><path d="M2 7.2a6.8 6.8 0 0 1 6.8 6.8M2 2.6A11.4 11.4 0 0 1 13.4 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

// A link to a feed: a click copies its address (readers want the URL, not
// the XML); a modified click opens it.
export function feedBtn(path, label = 'Feed', { small = false } = {}) {
  return `<a class="feed-btn${small ? ' sm' : ''}" href="${path.replace(/"/g, '&quot;')}" data-feed="${path.replace(/"/g, '&quot;')}" title="Copy the feed address for your reader (RSS; .json for JSON Feed)">${RSS_ICON}<span>${label}</span></a>`;
}

const KINDS = [['topic', 'Topic'], ['account', 'X account'], ['search', 'Search'], ['foryou', 'Your follows'], ['breaking', 'Breaking']];

export function createDevelopers({ $, esc, time, setHtml, store, state, reducedMotion, toast }) {
  const api = { d: null, error: null, pending: false };
  const sugg = { d: null, pending: false };
  const b = { kind: 'topic', topic: 'anthropic', account: 'OpenAI', q: '"open weights"', fmt: 'xml' };
  const preview = { key: null, items: null, error: null, pending: false, ms: 0 };
  const tries = new Map(); // endpoint path -> { pending, status, ms, bytes, text, error }

  const abs = (p) => new URL(p, location.href).href;

  async function load() {
    if (!api.d && !api.pending) {
      api.pending = true;
      try {
        const r = await fetch('/api');
        api.d = await r.json();
      } catch (err) {
        api.error = err.message;
      }
      api.pending = false;
      if (state.view === 'developers') render();
    }
    if (!sugg.d && !sugg.pending) {
      sugg.pending = true;
      try {
        sugg.d = await (await fetch('/api/follow/suggest')).json();
      } catch {
        sugg.d = { topics: [], accounts: [] };
      }
      sugg.pending = false;
      if (state.view === 'developers') render();
    }
  }

  // The For you follows in this browser, as feed parameters.
  function followsQuery() {
    const f = store.get('fw.follows', {}) || {};
    const p = new URLSearchParams();
    for (const [list, k] of [['topics', 't'], ['names', 'n'], ['accounts', 'a'], ['outlets', 'o']]) if (f[list]?.length) p.set(k, f[list].map((x) => x.key).join(','));
    return p.toString();
  }

  function feedPath(kind = b.kind, fmt = b.fmt) {
    if (kind === 'topic') return `/feeds/topic/${encodeURIComponent(b.topic)}.${fmt}`;
    if (kind === 'account') return `/feeds/account/${encodeURIComponent(b.account)}.${fmt}`;
    if (kind === 'search') return `/feeds/search.${fmt}?q=${encodeURIComponent(b.q)}`;
    if (kind === 'foryou') return followsQuery() ? `/feeds/foryou.${fmt}?${followsQuery()}` : null;
    return `/feeds/breaking.${fmt}`;
  }

  // The preview reads the JSON twin of the feed.
  async function loadPreview() {
    const p = feedPath(b.kind, 'json');
    if (!p || preview.key === p || preview.pending) return;
    preview.pending = true;
    const t0 = performance.now();
    try {
      const r = await fetch(p);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      preview.items = d.items;
      preview.title = d.title;
      preview.error = null;
    } catch (err) {
      preview.items = null;
      preview.error = err.message;
    }
    preview.ms = Math.round(performance.now() - t0);
    preview.key = p;
    preview.pending = false;
    if (state.view === 'developers') render();
    if (feedPath(b.kind, 'json') !== p) loadPreview(); // changed while loading
  }

  function builderHtml() {
    const topics = sugg.d?.topics || [];
    const accounts = sugg.d?.accounts || [];
    const field = {
      topic: `<label class="dv-field"><span>Topic</span><select data-dvset="topic">${(topics.some((t) => t.key === b.topic) ? topics : [{ key: b.topic, label: b.topic }, ...topics]).map((t) => `<option value="${esc(t.key)}"${t.key === b.topic ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>`,
      account: `<label class="dv-field"><span>Account</span><select data-dvset="account">${(accounts.some((a) => a.key === b.account) ? accounts : [{ key: b.account }, ...accounts]).map((a) => `<option value="${esc(a.key)}"${a.key === b.account ? ' selected' : ''}>@${esc(a.key)}</option>`).join('')}</select></label>`,
      search: `<label class="dv-field"><span>Search</span><input type="search" data-dvset="q" value="${esc(b.q)}" maxlength="200" spellcheck="false" enterkeyhint="go"></label>`,
      foryou: `<p class="dv-note">${followsQuery() ? 'Uses the follows saved in this browser. The address carries them, so it works in any reader.' : 'You don’t follow anything yet. <a href="#foryou">Pick a few in For you</a>, then come back.'}</p>`,
      breaking: '<p class="dv-note">Every story that breaks: four or more separate sources within the hour.</p>',
    }[b.kind];
    const p = feedPath();
    const items = preview.key === feedPath(b.kind, 'json') ? preview.items : null;
    const list = !p ? '' : preview.pending && !items
      ? '<div class="dv-preview" aria-busy="true"><i class="skeleton"></i><i class="skeleton w80"></i></div>'
      : preview.error && preview.key === feedPath(b.kind, 'json') ? `<p class="rail-note">${esc(preview.error)}</p>`
        : items ? `<div class="dv-preview"><p class="dv-meta">${items.length} item${items.length === 1 ? '' : 's'} now · built in ${preview.ms} ms</p><ol>${items.slice(0, 6).map((it, i) => `<li style="--i:${i}"><a href="${esc(it.external_url || it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a><span>${esc(it.authors?.[0]?.name || '')}${it.date_published ? ` · ${time(Date.parse(it.date_published))}` : ''}</span></li>`).join('')}</ol></div>` : '';
    return `<section class="topic-card dv-builder">
      <h2>Make a feed</h2>
      <div class="seg dv-kinds" role="group" aria-label="Feed of">${KINDS.map(([k, l]) => `<button type="button" data-dvkind="${k}" aria-pressed="${b.kind === k}">${l}</button>`).join('')}</div>
      <div class="dv-row">${field}
        <div class="seg" role="group" aria-label="Format"><button type="button" data-dvfmt="xml" aria-pressed="${b.fmt === 'xml'}">RSS</button><button type="button" data-dvfmt="json" aria-pressed="${b.fmt === 'json'}">JSON Feed</button></div>
      </div>
      ${p ? `<div class="dv-url"><code>${esc(abs(p))}</code><button type="button" class="dv-copy" data-dvcopy="${esc(p)}">Copy</button><a class="dv-open" href="${esc(p)}" target="_blank" rel="noopener">Open ↗</a></div>` : ''}
      ${list}
    </section>`;
  }

  // ---- Endpoints ----
  // Example ids come from what's on the page now.
  function fill(url) {
    const sn = state.data || {};
    const story = sn.stories?.[0];
    return url
      .replace('{sid}', encodeURIComponent(story?.sid || ''))
      .replace('{id}', encodeURIComponent(story?.id || ''))
      .replace('{release}', encodeURIComponent(sn.releases?.[0]?.id || ''))
      .replace('{market}', encodeURIComponent(sn.markets?.[0]?.id || ''));
  }

  // Pretty JSON with token classes; long arrays and strings are cut.
  function pretty(v, depth = 0, budget = { n: 260 }) {
    const pad = '  '.repeat(depth);
    if (budget.n-- <= 0) return '<span class="j-cut">…</span>';
    if (v === null) return '<span class="j-l">null</span>';
    if (typeof v === 'boolean') return `<span class="j-l">${v}</span>`;
    if (typeof v === 'number') return `<span class="j-n">${v}</span>`;
    if (typeof v === 'string') return `<span class="j-s">"${esc(v.length > 140 ? `${v.slice(0, 140)}…` : v)}"</span>`;
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const shown = v.slice(0, 3).map((x) => `${pad}  ${pretty(x, depth + 1, budget)}`);
      if (v.length > 3) shown.push(`${pad}  <span class="j-cut">… ${v.length - 3} more</span>`);
      return `[\n${shown.join(',\n')}\n${pad}]`;
    }
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}  <span class="j-k">"${esc(k)}"</span>: ${pretty(v[k], depth + 1, budget)}`).join(',\n')}\n${pad}}`;
  }

  async function tryIt(path, url) {
    tries.set(path, { pending: true });
    render();
    const t0 = performance.now();
    let entry;
    try {
      const r = await fetch(url);
      const text = await r.text();
      entry = { status: r.status, ms: Math.round(performance.now() - t0), bytes: text.length, text };
    } catch (err) {
      entry = { error: err.message };
    }
    tries.set(path, entry);
    if (state.view === 'developers') render();
  }

  function resultHtml(t) {
    if (!t) return '';
    if (t.pending) return '<div class="dv-out" aria-busy="true"><i class="skeleton"></i><i class="skeleton w80"></i></div>';
    if (t.error) return `<div class="dv-out"><p class="rail-note">${esc(t.error)}</p></div>`;
    let body;
    try {
      body = pretty(JSON.parse(t.text));
    } catch {
      body = esc(t.text.slice(0, 2000));
    }
    const kb = t.bytes > 1024 ? `${(t.bytes / 1024).toFixed(1)} KB` : `${t.bytes} B`;
    return `<div class="dv-out"><p class="dv-meta"><b class="${t.status < 400 ? 'ok' : 'bad'}">${t.status}</b> · ${t.ms} ms · ${kb}</p><pre><code>${body}</code></pre></div>`;
  }

  function endpointsHtml() {
    if (!api.d) return api.error ? `<p class="rail-note">${esc(api.error)}</p>` : '<i class="skeleton"></i><i class="skeleton w80"></i>';
    const groups = new Map();
    for (const e of api.d.endpoints) groups.has(e.group) ? groups.get(e.group).push(e) : groups.set(e.group, [e]);
    return [...groups].map(([g, list]) => `<section class="dv-group"><h3>${esc(g)}</h3>${list.map((e) => {
      const url = fill(e.example);
      const t = tries.get(e.path);
      const open = tries.has(e.path);
      return `<details class="dv-ep" data-id="${esc(e.path)}"${open ? ' open' : ''}>
        <summary><span class="dv-get">GET</span><code>${esc(e.path)}</code><span class="dv-sum">${esc(e.summary)}</span></summary>
        <div class="dv-body">
          ${e.params.length ? `<table class="dv-params"><tbody>${e.params.map((p) => `<tr><th scope="row"><code>${esc(p.name)}</code>${p.required ? '<small>required</small>' : ''}</th><td>${esc(p.about)}</td></tr>`).join('')}</tbody></table>` : ''}
          ${e.notes ? `<p class="dv-note">${esc(e.notes)}</p>` : ''}
          <div class="dv-url"><code>${esc(url)}</code><button type="button" class="dv-copy" data-dvcopy="${esc(url)}">Copy</button><button type="button" class="dv-try" data-dvtry="${esc(e.path)}" data-dvurl="${esc(url)}">${t && !t.pending ? 'Run again' : 'Try it'}</button></div>
          ${resultHtml(t)}
        </div>
      </details>`;
    }).join('')}</section>`).join('');
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `API and feeds · ${name}`;
    if (state.mode !== 'api') {
      setHtml($('#developersView'), '<header class="topic-head"><p class="kicker">Developers</p><h1>API and feeds</h1><p class="topic-sum">The API needs the live server.</p></header>');
      return;
    }
    load();
    loadPreview();
    // Panels someone opened stay open across re-renders.
    const opened = new Set([...document.querySelectorAll('#developersView details[open]')].map((x) => x.dataset.id));
    for (const id of opened) if (!tries.has(id)) tries.set(id, null);
    setHtml($('#developersView'), `
      <header class="topic-head">
        <a class="back" href="#news">← News</a>
        <p class="kicker">Developers</p>
        <h1>API and feeds</h1>
        <p class="topic-sum">Everything on this site is open to read: a JSON API with no key, and feeds for any topic, X account, search or set of follows. Responses are compressed and cacheable; feeds send ETags, so polling an unchanged one costs nothing.</p>
      </header>
      <div class="topic-grid">
        <div class="dv-main">
          ${builderHtml()}
          <section class="dv-eps"><h2>Endpoints</h2>${endpointsHtml()}</section>
        </div>
        <aside class="topic-side">
          <section><h2>Good to know</h2><ul class="dv-notes">
            <li>All endpoints are <code>GET</code> and return JSON. <a href="/api" target="_blank" rel="noopener"><code>/api</code></a> lists them.</li>
            <li>Searches share a rate limit per connection; a 429 says when to retry.</li>
            <li>Every feed comes as RSS and as JSON Feed: swap <code>.xml</code> for <code>.json</code>.</li>
            <li>A Feed button on topic, account, For you and breaking pages copies that page’s feed.</li>
          </ul></section>
          <section><h2>Feeds</h2><ul class="dv-feeds">${(api.d?.feeds || []).map((f) => `<li><code>${esc(f.path)}</code><span>${esc(f.summary)}</span></li>`).join('')}</ul></section>
        </aside>
      </div>`);
  }

  async function copy(path) {
    const url = abs(path);
    try {
      await navigator.clipboard.writeText(url);
      toast?.('Feed address copied. Paste it into your reader.');
    } catch {
      prompt('Copy this address:', url);
    }
  }

  function onClick(t, e) {
    const d = t.dataset;
    if (d.feed) {
      if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return false; // open it
      e?.preventDefault();
      copy(d.feed);
      return true;
    }
    if (d.dvcopy) {
      e?.preventDefault();
      navigator.clipboard?.writeText(abs(d.dvcopy)).then(() => toast?.('Copied'), () => prompt('Copy this address:', abs(d.dvcopy)));
      return true;
    }
    if (d.dvkind) {
      b.kind = d.dvkind;
      render();
      return true;
    }
    if (d.dvfmt) {
      b.fmt = d.dvfmt;
      render();
      return true;
    }
    if (d.dvtry) {
      tryIt(d.dvtry, d.dvurl);
      return true;
    }
    return false;
  }

  function onChange(el) {
    const k = el.dataset?.dvset;
    if (!k) return false;
    const v = el.value.trim();
    if (!v) return true;
    b[k] = v;
    render();
    return true;
  }

  return { render, onClick, onChange };
}
