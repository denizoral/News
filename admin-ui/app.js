// Admin dashboard. Plain ES module, no third-party code. Every value from the
// server is escaped before it touches the DOM; the CSP blocks inline scripts.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Intl.NumberFormat('en').format(n || 0);
const compact = (n) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const bytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`);
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
function ago(t) {
  if (!t) return 'never';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const S = { session: null, view: 'overview', settings: null };

// ---------- API ----------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (S.session?.csrf) headers['x-csrf-token'] = S.session.csrf;
  }
  const res = await fetch(`/api/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  let data = null;
  try {
    data = await res.json();
  } catch { /* empty */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    // Sign-in endpoints report their own errors; anything else that says the
    // session ended (or a step is pending) sends us back through sign-in.
    if (!path.startsWith('/login') && (res.status === 401 || (res.status === 403 && data?.next))) {
      // Session ended or a step is pending: go back through the sign-in flow.
      setTimeout(boot, 0);
    }
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r;
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'bad');
    throw e;
  }
}

const can = (perm) => S.session?.permissions?.includes(perm);

// ---------- modal ----------

function modal(html, onMount) {
  const d = $('#modal');
  $('#modalBody').innerHTML = html;
  d.showModal();
  onMount?.($('#modalBody'));
  return d;
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) $('#modal').close();
});

function confirmAction({ title, body, confirm = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    modal(`<h2 id="modalTitle">${esc(title)}</h2><p>${body}</p>
      ${typeToConfirm ? `<label class="field"><span>Type <code>${esc(typeToConfirm)}</code> to confirm</span><input type="text" id="ttc" autocomplete="off"></label>` : ''}
      <div class="form-actions"><button class="btn ${danger ? 'danger' : 'primary'}" id="cOk" ${typeToConfirm ? 'disabled' : ''}>${esc(confirm)}</button><button class="btn" data-close>Cancel</button></div>`, (el) => {
      const ok = $('#cOk', el);
      if (typeToConfirm) $('#ttc', el).addEventListener('input', (e) => (ok.disabled = e.target.value !== typeToConfirm));
      ok.addEventListener('click', () => { $('#modal').close(); resolve(true); });
      $('#modal').addEventListener('close', () => resolve(false), { once: true });
    });
  });
}

// ---------- auth screens ----------

function authCard(inner) {
  $('#root').innerHTML = `<div class="auth"><div class="auth-card"><div class="brand"><img src="favicon.svg" alt="">Admin</div>${inner}</div></div>`;
}

function formError(form, msg) {
  let el = $('.field-error.form', form);
  if (!el) {
    el = document.createElement('p');
    el.className = 'field-error form';
    el.setAttribute('role', 'alert');
    form.prepend(el);
  }
  el.textContent = msg;
}

function showSetupRequired() {
  authCard(`<h1>No admin accounts yet</h1>
    <p>For security, the first account can only be created on the server itself, not from the web.</p>
    <p>On the server, run:</p><pre class="robots">npm run admin -- create your-name</pre>
    <p class="muted small">You'll type a password at a hidden prompt, then come back here to sign in and set up two-factor sign-in.</p>`);
}

function showLogin(message = '') {
  authCard(`<h1>Sign in</h1>${message ? `<p class="notice info">${esc(message)}</p>` : ''}
    <form id="loginForm" novalidate>
      <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required maxlength="64" autofocus></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>
      <button class="btn primary" type="submit">Sign in</button>
    </form>`);
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('button', f);
    btn.disabled = true;
    try {
      await api('POST', '/login', { username: f.username.value.trim(), password: f.password.value });
      f.password.value = '';
      boot();
    } catch (err) {
      formError(f, err.message);
      f.password.value = '';
      f.password.focus();
    } finally {
      btn.disabled = false;
    }
  });
}

function showMfa() {
  authCard(`<h1>Two-factor sign-in</h1><p>Enter the 6-digit code from your authenticator app.</p>
    <form id="mfaForm" novalidate>
      <label class="field"><span>Code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus></label>
      <button class="btn primary" type="submit">Verify</button>
      <button class="btn" type="button" id="useRecovery">Use a recovery code instead</button>
    </form>`);
  let recovery = false;
  $('#useRecovery').addEventListener('click', () => {
    recovery = !recovery;
    const input = $('#mfaForm input');
    input.removeAttribute('pattern');
    input.maxLength = recovery ? 20 : 6;
    input.inputMode = recovery ? 'text' : 'numeric';
    input.previousElementSibling.textContent = recovery ? 'Recovery code' : 'Code';
    $('#useRecovery').textContent = recovery ? 'Use an authenticator code instead' : 'Use a recovery code instead';
    input.value = '';
    input.focus();
  });
  $('#mfaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = e.target.code.value.trim();
    try {
      await api('POST', '/login/mfa', recovery ? { recoveryCode: v } : { code: v });
      boot();
    } catch (err) {
      formError(e.target, err.message);
      e.target.code.select();
    }
  });
}

async function showEnroll() {
  authCard('<h1>Set up two-factor sign-in</h1><p>This server requires it for every admin account.</p><p class="muted">Loading…</p>');
  let t;
  try {
    t = await api('POST', '/account/totp/begin', {});
  } catch (err) {
    return authCard(`<h1>Set up two-factor sign-in</h1><p class="notice bad">${esc(err.message)}</p>`);
  }
  authCard(`<h1>Set up two-factor sign-in</h1>
    <p>Scan this with an authenticator app (1Password, Google Authenticator, Authy…), then enter the code it shows.</p>
    <div class="qr">${t.qr}</div>
    <p class="small muted">Can't scan? Enter this key: <code>${esc(t.secret.match(/.{1,4}/g).join(' '))}</code></p>
    <form id="enrollForm" novalidate>
      <label class="field"><span>Code from the app</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus></label>
      <button class="btn primary" type="submit">Turn on two-factor sign-in</button>
    </form>`);
  $('#enrollForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/account/totp/confirm', { code: e.target.code.value.trim() });
      showRecoveryCodes(r.recoveryCodes);
    } catch (err) {
      formError(e.target, err.message);
    }
  });
}

function showRecoveryCodes(codes) {
  authCard(`<h1>Save your recovery codes</h1>
    <p>If you lose your phone, each of these codes signs you in once. They won't be shown again.</p>
    <div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="row"><button class="btn" id="copyCodes">Copy codes</button><button class="btn primary" id="doneCodes">I've saved them</button></div>`);
  $('#copyCodes').addEventListener('click', () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied')));
  $('#doneCodes').addEventListener('click', boot);
}

function showForcedPassword() {
  authCard(`<h1>Choose a new password</h1><p>Your account was set up with a temporary password. Pick your own to continue.</p>${passwordFormHtml()}`);
  bindPasswordForm($('#pwForm'), boot);
}

function passwordFormHtml() {
  return `<form id="pwForm" novalidate>
    <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
    <label class="field"><span>New password</span><input type="password" name="next" autocomplete="new-password" required minlength="12" maxlength="256"><small>At least 12 characters. A few random words work well.</small></label>
    <label class="field"><span>New password again</span><input type="password" name="again" autocomplete="new-password" required></label>
    <button class="btn primary" type="submit">Change password</button></form>`;
}

function bindPasswordForm(form, done) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.next.value !== form.again.value) return formError(form, "The new passwords don't match.");
    try {
      await api('POST', '/account/password', { current: form.current.value, next: form.next.value });
      form.reset();
      toast('Password changed. Other sessions were signed out.');
      done();
    } catch (err) {
      formError(form, err.message);
    }
  });
}

// ---------- shell ----------

const NAV = [
  ['overview', 'Overview', null],
  ['content', 'Content', null],
  ['site', 'Site', null],
  ['crawler', 'Crawler', null],
  ['sources', 'Sources', null],
  ['storage', 'Storage & limits', null],
  ['users', 'Users', 'users:manage'],
  ['audit', 'Audit log', 'audit:read'],
  ['account', 'Your account', null],
];

function shell() {
  const u = S.session.user;
  $('#root').innerHTML = `<div class="shell">
    <nav class="side" aria-label="Admin sections">
      <div class="brand"><img src="favicon.svg" alt="">Admin</div>
      ${NAV.filter(([, , p]) => !p || can(p)).map(([k, l]) => `<a href="#${k}" data-nav="${k}">${l}</a>`).join('')}
      <div class="who"><span><b>${esc(u.username)}</b>${esc(u.role)}</span><button class="btn small" id="signOut">Sign out</button></div>
    </nav>
    <main id="view" tabindex="-1"></main>
  </div>`;
  $('#signOut').addEventListener('click', async () => {
    await api('POST', '/logout', {}).catch(() => {});
    S.session = null;
    showLogin('You are signed out.');
  });
}

async function route() {
  clearInterval(S.timer);
  const [v0, sub] = (location.hash.replace('#', '') || 'overview').split('/');
  const v = v0 || 'overview';
  S.sub = sub || '';
  const item = NAV.find(([k, , p]) => k === v && (!p || can(p)));
  S.view = item ? v : 'overview';
  $$('[data-nav]').forEach((a) => (a.dataset.nav === S.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  // A fresh container per visit: views attach listeners to it, and reusing the
  // old one would stack them (one click firing an action twice).
  const old = $('#view');
  const el = old.cloneNode(false);
  old.replaceWith(el);
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await VIEWS[S.view](el);
  } catch (e) {
    if (e.status !== 401) el.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
  el.focus({ preventScroll: true });
}

window.addEventListener('hashchange', () => S.session?.state === 'ok' && route());

// ---------- settings forms (generated from the server's schema) ----------

async function loadSettings() {
  S.settings = (await api('GET', '/settings')).settings;
  return S.settings;
}

function fieldHtml(d) {
  const id = `f_${d.key.replace(/\W/g, '_')}`;
  const help = d.help ? `<small>${esc(d.help)}</small>` : '';
  const updated = d.updated ? `<small class="muted">Changed by ${esc(d.updated.by || 'unknown')} ${ago(d.updated.at)}</small>` : '';
  const dis = !canEditSetting(d) ? 'disabled' : '';
  switch (d.type) {
    case 'bool':
      return `<div class="field" data-key="${esc(d.key)}"><label class="toggle"><input type="checkbox" id="${id}" ${d.value ? 'checked' : ''} ${dis}><span><b>${esc(d.label)}</b></span></label>${help}${updated}<span class="field-error"></span></div>`;
    case 'int':
    case 'number':
      return `<label class="field" data-key="${esc(d.key)}"><span>${esc(d.label)}</span><input type="number" id="${id}" value="${esc(d.value)}" min="${d.min}" max="${d.max}" step="${d.type === 'int' ? 1 : 'any'}" ${dis}>${help}<small class="muted">${fmt(d.min)} to ${fmt(d.max)}</small>${updated}<span class="field-error"></span></label>`;
    case 'text':
      return `<label class="field wide" data-key="${esc(d.key)}"><span>${esc(d.label)}</span><textarea id="${id}" rows="8" maxlength="${d.max}" spellcheck="false" ${dis}>${esc(d.value)}</textarea>${help}${updated}<span class="field-error"></span></label>`;
    case 'enum':
      return `<label class="field" data-key="${esc(d.key)}"><span>${esc(d.label)}</span><select id="${id}" ${dis}>${d.options.map(([k, l]) => `<option value="${esc(k)}" ${k === d.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${help}${updated}<span class="field-error"></span></label>`;
    case 'words':
    case 'patterns':
      return `<label class="field" data-key="${esc(d.key)}"><span>${esc(d.label)} <span class="muted">(${d.value.length})</span></span><textarea id="${id}" rows="5" spellcheck="false" ${dis}>${esc(d.value.join('\n'))}</textarea>${help}${updated}<span class="field-error"></span></label>`;
    case 'urls':
    case 'hosts':
      return `<label class="field wide" data-key="${esc(d.key)}"><span>${esc(d.label)} <span class="muted">(${d.value.length})</span></span><textarea id="${id}" rows="10" spellcheck="false" ${dis}>${esc(d.value.join('\n'))}</textarea>${help}${updated}<span class="field-error"></span></label>`;
    case 'hostRules':
      // The card around it already carries the title and explanation.
      return `<div class="field wide" data-key="${esc(d.key)}">
        <div class="rule-row rule-head"><span>Host</span><span>Block</span><span>Ignore robots.txt</span><span>Min gap (ms)</span><span>Pages / day</span><span>Extra blocked paths (one per line)</span><span></span></div>
        <div class="rules">${d.value.map((r) => ruleRow(r)).join('')}</div>
        ${dis ? '' : '<button class="btn small" type="button" data-add-rule>Add a site rule</button>'}${updated}<span class="field-error"></span></div>`;
    default:
      return `<label class="field" data-key="${esc(d.key)}"><span>${esc(d.label)}</span><input type="${d.type === 'url' ? 'url' : 'text'}" id="${id}" value="${esc(d.value)}" maxlength="${d.max || 2000}" ${dis}>${help}${updated}<span class="field-error"></span></label>`;
  }
}

function ruleRow(r = { host: '', blocked: false, ignoreRobots: false, minDelayMs: null, dailyBudget: null, disallow: [] }) {
  // Only owners may change which sites ignore robots.txt (the server enforces this too).
  const owner = S.session.user.role === 'owner';
  return `<div class="rule-row${r.ignoreRobots ? ' ignores-robots' : ''}" data-rule>
    <input type="text" data-r="host" value="${esc(r.host)}" placeholder="example.com" aria-label="Host">
    <label class="toggle"><input type="checkbox" data-r="blocked" ${r.blocked ? 'checked' : ''} aria-label="Block this site"></label>
    <label class="toggle" title="${owner ? 'Fetch this site even where its robots.txt says no. Use only for sites you own or have permission to crawl.' : 'Only owners can change this.'}"><input type="checkbox" data-r="ignoreRobots" ${r.ignoreRobots ? 'checked' : ''} ${owner ? '' : 'disabled'} aria-label="Ignore robots.txt for this site"></label>
    <input type="number" data-r="minDelayMs" value="${r.minDelayMs ?? ''}" min="500" placeholder="default" aria-label="Minimum gap in ms">
    <input type="number" data-r="dailyBudget" value="${r.dailyBudget ?? ''}" min="0" placeholder="default" aria-label="Pages per day">
    <textarea data-r="disallow" placeholder="/paywall/" aria-label="Blocked paths">${esc((r.disallow || []).join('\n'))}</textarea>
    <button class="btn small danger" type="button" data-remove-rule aria-label="Remove rule">Remove</button>
  </div>`;
}

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const canEditSetting = (d) => ROLE_RANK[S.session.user.role] >= ROLE_RANK[d.role];

function readField(d, el) {
  const input = $('input, textarea', el);
  switch (d.type) {
    case 'bool': return input.checked;
    case 'int': case 'number': return input.value === '' ? null : Number(input.value);
    case 'urls': case 'hosts': case 'words': case 'patterns': return input.value.split('\n').map((s) => s.trim()).filter(Boolean);
    case 'enum': return $('select', el).value;
    case 'hostRules':
      return $$('[data-rule]', el).map((row) => ({
        host: $('[data-r=host]', row).value.trim(),
        blocked: $('[data-r=blocked]', row).checked,
        ignoreRobots: $('[data-r=ignoreRobots]', row).checked,
        minDelayMs: $('[data-r=minDelayMs]', row).value === '' ? null : Number($('[data-r=minDelayMs]', row).value),
        dailyBudget: $('[data-r=dailyBudget]', row).value === '' ? null : Number($('[data-r=dailyBudget]', row).value),
        disallow: $('[data-r=disallow]', row).value.split('\n').map((s) => s.trim()).filter(Boolean),
      })).filter((r) => r.host);
    default: return input.value;
  }
}

// Renders a form for the given settings and saves only what changed.
function settingsForm(container, defs, opts = {}) {
  const { title, intro = '' } = opts;
  container.insertAdjacentHTML('beforeend', `<section class="card" data-form>
    ${title ? `<h2>${esc(title)}</h2>` : ''}${intro ? `<p class="muted">${intro}</p>` : ''}
    <div class="form-grid">${defs.map(fieldHtml).join('')}</div>
    <div class="form-actions"><button class="btn primary" data-save disabled>Save changes</button><button class="btn" data-reset disabled>Discard</button><span class="muted small" data-status></span></div>
  </section>`);
  const card = container.lastElementChild;
  const save = $('[data-save]', card);
  const reset = $('[data-reset]', card);
  const changed = () => defs.filter((d) => {
    const el = $(`[data-key="${CSS.escape(d.key)}"]`, card);
    return JSON.stringify(readField(d, el)) !== JSON.stringify(d.value);
  });
  const refresh = () => {
    const n = changed().length;
    save.disabled = reset.disabled = !n;
    $('[data-status]', card).textContent = n ? `${n} unsaved ${n === 1 ? 'change' : 'changes'}` : '';
  };
  card.addEventListener('input', refresh);
  card.addEventListener('change', refresh);
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-rule]')) {
      $('.rules', e.target.closest('.field')).insertAdjacentHTML('beforeend', ruleRow());
      refresh();
    }
    if (e.target.closest('[data-remove-rule]')) {
      e.target.closest('[data-rule]').remove();
      refresh();
    }
  });
  reset.addEventListener('click', () => route());
  save.addEventListener('click', async () => {
    const patch = Object.fromEntries(changed().map((d) => [d.key, readField(d, $(`[data-key="${CSS.escape(d.key)}"]`, card))]));
    if (opts.beforeSave && !(await opts.beforeSave(patch))) return;
    $$('.field', card).forEach((f) => { f.classList.remove('invalid'); const fe = $('.field-error', f); if (fe) fe.textContent = ''; });
    save.disabled = true;
    try {
      const r = await api('PATCH', '/settings', patch);
      S.settings = r.settings;
      toast(`Saved ${r.changed.length} ${r.changed.length === 1 ? 'setting' : 'settings'}.`);
      route();
    } catch (err) {
      for (const [k, msg] of Object.entries(err.body?.fields || {})) {
        const f = $(`[data-key="${CSS.escape(k)}"]`, card);
        if (f) { f.classList.add('invalid'); $('.field-error', f).textContent = msg; }
      }
      toast(err.message, 'bad');
      refresh();
    }
  });
  return card;
}

const group = (g) => S.settings.filter((d) => d.group === g);

// ---------- views ----------

const VIEWS = {
  async overview(el) {
    const o = await api('GET', '/overview');
    const failing = o.sources.filter((s) => !s.ok);
    const weak = o.security.filter((c) => !c.ok);
    el.innerHTML = `<div class="page-head"><div><h1>Overview</h1><p>Updated ${ago(o.feed.generatedAt)}.</p></div></div>
      <div class="stats">
        <div class="stat"><b>${compact(o.content.total)}</b><span>documents indexed</span></div>
        <div class="stat"><b>${compact(o.crawler.crawledPages)}</b><span>pages crawled in full</span></div>
        <div class="stat"><b>${o.crawler.paused ? 'Paused' : `${o.crawler.pagesPerMinute}/min`}</b><span>crawler speed</span></div>
        <div class="stat"><b>${compact(o.crawler.queued)}</b><span>URLs queued</span></div>
        <div class="stat"><b>${bytes(o.storage.dbBytes)}</b><span>database</span></div>
        <div class="stat"><b>${bytes(o.storage.mediaBytes)}</b><span>${compact(o.storage.images)} images stored</span></div>
      </div>
      <div class="grid grid-2">
        <section class="card"><h2>Live feed</h2>
          <p>${fmt(o.feed.stories)} stories, ${fmt(o.feed.builds)} projects and ${fmt(o.feed.markets)} markets on the site now.</p>
          <p>${fmt(o.content.hidden)} hidden, ${fmt(o.content.pinned)} pinned, ${fmt(o.content.edited)} edited by hand.</p>
          ${failing.length ? `<div class="notice warn">${failing.length} ${failing.length === 1 ? 'source is' : 'sources are'} failing: ${failing.map((s) => esc(s.name)).join(', ')}. <a href="#sources">See sources</a></div>` : '<div class="notice ok">All sources are working.</div>'}
        </section>
        <section class="card"><h2>Security posture</h2>
          ${weak.length ? `<p class="muted">${weak.length} of ${o.security.length} recommended settings are missing.</p>` : '<p class="muted">Everything recommended is in place.</p>'}
          <ul class="checks">${o.security.map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><span class="mark">${c.ok ? '✓' : '!'}</span><span>${esc(c.label)}${c.ok ? '' : `<br><span class="muted small">${esc(c.fix)}</span>`}</span></li>`).join('')}</ul>
        </section>
      </div>
      ${o.recentActivity.length ? `<section class="card"><h2>Recent activity</h2>${auditTable(o.recentActivity)}<p><a href="#audit">Full audit log</a></p></section>` : ''}`;
  },

  async content(el) {
    const params = new URLSearchParams(sessionStorage.getItem('adm.content') || '');
    const state = { q: params.get('q') || '', type: params.get('type') || '', state: params.get('state') || 'all', page: Number(params.get('page')) || 1 };
    el.innerHTML = `<div class="page-head"><div><h1>Content</h1><p>Fix headlines, hide or remove stories, pin them to the top of the front page.</p></div></div>
      <section class="card">
        <form class="row" id="cFilter">
          <input type="search" name="q" placeholder="Search titles and text" value="${esc(state.q)}" aria-label="Search content">
          <select name="type" aria-label="Type"><option value="">All types</option>${['article', 'post', 'build', 'model', 'market'].map((t) => `<option ${state.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <select name="state" aria-label="State">${[['all', 'Everything'], ['visible', 'Visible'], ['hidden', 'Hidden or removed'], ['pinned', 'Pinned'], ['edited', 'Edited by hand'], ['crawled', 'Crawled in full']].map(([k, l]) => `<option value="${k}" ${state.state === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn" type="submit">Search</button>
        </form>
        <div id="cList"><p class="muted">Loading…</p></div>
      </section>`;
    const load = async () => {
      sessionStorage.setItem('adm.content', new URLSearchParams({ q: state.q, type: state.type, state: state.state, page: state.page }).toString());
      const r = await api('GET', `/content?${new URLSearchParams({ q: state.q, type: state.type, state: state.state, page: state.page })}`);
      const pages = Math.ceil(r.total / r.perPage);
      $('#cList').innerHTML = r.items.length ? `<p class="muted small">${fmt(r.total)} documents</p><div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Site</th><th>Published</th><th>State</th></tr></thead><tbody>
        ${r.items.map((d) => `<tr class="clickable" data-doc="${d.id}"><td class="trunc"><b>${esc(d.title)}</b><span class="sub">${esc(d.url)}</span></td><td>${esc(d.type)}</td><td>${esc(d.site)}</td><td class="num">${d.publishedAt ? ago(d.publishedAt) : '—'}</td>
          <td>${d.hidden ? (d.locked && !d.description ? '<span class="pill bad">removed</span>' : '<span class="pill warn">hidden</span>') : ''}${d.pinned ? '<span class="pill info">pinned</span>' : ''}${d.locked && !d.hidden ? '<span class="pill">edited</span>' : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="row" style="margin-top:12px"><button class="btn small" data-page="-1" ${state.page <= 1 ? 'disabled' : ''}>Previous</button><span class="muted small">Page ${state.page} of ${Math.max(1, pages)}</span><button class="btn small" data-page="1" ${state.page >= pages ? 'disabled' : ''}>Next</button></div>`
        : '<p class="empty">No documents match. Clear the search or choose Everything.</p>';
    };
    $('#cFilter').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(state, { q: e.target.q.value.trim(), type: e.target.type.value, state: e.target.state.value, page: 1 });
      load();
    });
    el.addEventListener('click', (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg) { state.page += Number(pg.dataset.page); return load(); }
      const row = e.target.closest('[data-doc]');
      if (row) editDoc(Number(row.dataset.doc), load);
    });
    await load();
  },

  async site(el) {
    await loadSettings();
    el.innerHTML = '<div class="page-head"><div><h1>Site</h1><p>What visitors see: the name, the announcement banner, which sections appear, and the robots.txt you serve.</p></div></div>';
    settingsForm(el, group('site').filter((d) => d.key !== 'site.robotsTxt'), { title: 'Page' });
    settingsForm(el, group('site').filter((d) => d.key === 'site.robotsTxt'), { title: 'robots.txt', intro: 'Controls what other crawlers may fetch from this site. It applies to everyone; it is a request, not access control, so never rely on it to hide anything.' });
  },

  async crawler(el) {
    await loadSettings();
    const writable = can('crawler:write');
    const tabs = [['status', 'Status'], ['log', 'Log'], ['settings', 'Settings'], ['sites', 'Sites'], ['test', 'Test a URL']];
    const tab = tabs.some(([k]) => k === S.sub) ? S.sub : 'status';
    const enabled = S.settings.find((d) => d.key === 'crawler.enabled')?.value;
    el.innerHTML = `<div class="page-head"><div><h1>Crawler</h1><p id="crawlState" class="muted">Loading…</p></div>
        ${writable ? `<button class="btn ${enabled ? 'danger' : 'primary'}" id="pauseBtn">${enabled ? 'Pause crawling' : 'Resume crawling'}</button>` : ''}</div>
      <nav class="tabs-row" aria-label="Crawler sections">${tabs.map(([k, l]) => `<a href="#crawler/${k}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div id="crawlTab"></div>`;
    $('#pauseBtn', el)?.addEventListener('click', async () => {
      if (enabled && !(await confirmAction({ title: 'Pause the crawler?', body: 'Page and image fetches stop until you resume. The queue is kept and the feed keeps updating.', confirm: 'Pause', danger: true }))) return;
      await act(() => api('PATCH', '/settings', { 'crawler.enabled': !enabled }), enabled ? 'Crawler paused.' : 'Crawler resumed.');
      route();
    });
    const box = $('#crawlTab', el);
    const setState = (live) => {
      const words = { crawling: 'Crawling', idle: 'Idle: nothing is due right now', paused: 'Paused', 'quiet hours': `Quiet hours (${live.quietHours} UTC; it's ${live.utcTime} UTC now)`, 'pages-per-minute cap': 'Waiting: the pages-per-minute cap was reached', stopped: 'Stopped on this server (SPIDER=off)' };
      $('#crawlState', el).textContent = `${words[live.state] || live.state}. ${live.active} of ${live.concurrency} fetch slots in use.`;
    };
    await CRAWLER_TABS[tab](box, { writable, setState });
  },

  async sources(el) {
    await loadSettings();
    const r = await api('GET', '/sources');
    const writable = can('sources:write');
    const def = (name, k) => S.settings.find((d) => d.key === `sources.${name}.${k}`);
    const label = (name) => (def(name, 'enabled')?.label || name).replace(/: enabled$/, '');
    const every = (sec) => (sec < 60 ? `${sec} s` : sec < 3600 ? `${+(sec / 60).toFixed(1)} min` : `${+(sec / 3600).toFixed(1)} h`);
    const statusCell = (s, enabled) => !enabled ? '<span class="pill">off</span>'
      : s?.paused ? '<span class="pill">off</span>'
      : !s?.lastRun ? '<span class="pill">waiting for first run</span>'
      : s.ok ? '<span class="pill ok">working</span>'
      : `<span class="pill bad">failing</span><span class="sub" title="${esc(s.error || '')}">${esc((s.error || '').slice(0, 120))}</span>`;
    const original = Object.fromEntries(r.sources.map((s) => [s.name, { enabled: s.enabled, intervalSec: s.intervalSec }]));
    const min = def(r.sources[0]?.name, 'intervalSec')?.min ?? 30;
    const max = def(r.sources[0]?.name, 'intervalSec')?.max ?? 86400;

    el.innerHTML = `<div class="page-head"><div><h1>Sources</h1><p>The feeds and APIs behind the live front page: whether each one is on, how often it runs, and whether it's working.</p></div></div>
      <section class="card" id="srcCard">
        <div class="table-wrap"><table class="sources-table"><thead><tr>
          <th>Source</th><th>Status</th><th class="num">Items</th><th>Last run</th><th>On</th><th>Runs every</th><th></th>
        </tr></thead><tbody>
        ${r.sources.map((s) => `<tr data-src="${esc(s.name)}">
          <td class="c-name"><b>${esc(label(s.name))}</b>${s.status?.strategy ? `<span class="sub">via ${esc(s.status.strategy)}</span>` : ''}</td>
          <td class="c-status" data-cell="status">${statusCell(s.status, s.enabled)}</td>
          <td class="c-count num" data-cell="count" data-label="Items">${s.status?.lastRun ? fmt(s.status.count) : '—'}</td>
          <td class="c-last num muted" data-cell="last" data-label="Last run">${s.status?.lastRun ? ago(s.status.lastRun) : '—'}</td>
          <td class="c-on"><label class="toggle"><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''} ${writable ? '' : 'disabled'} aria-label="${esc(label(s.name))} on"><span class="mobile-only">On</span></label></td>
          <td class="c-every"><div class="interval"><input type="number" data-f="intervalSec" value="${s.intervalSec}" min="${min}" max="${max}" step="1" ${writable ? '' : 'disabled'} aria-label="${esc(label(s.name))}: seconds between runs"><span class="muted small">s</span><span class="muted small" data-hint>${every(s.intervalSec)}</span></div>
            <span class="field-error"></span></td>
          <td class="c-run">${writable ? `<button class="btn small" data-run="${esc(s.name)}" ${s.enabled ? '' : 'disabled'}>Run now</button>` : ''}</td>
        </tr>`).join('')}
        </tbody></table></div>
        <p class="help" style="margin-top:12px">Intervals are in seconds, from ${fmt(min)} to ${fmt(max)}. Faster isn't always better: many sources rate-limit clients that poll too often.</p>
        ${writable ? '<div class="form-actions"><button class="btn primary" data-save disabled>Save changes</button><button class="btn" data-reset disabled>Discard</button><span class="muted small" data-status></span></div>' : ''}
      </section>`;

    const card = $('#srcCard', el);
    const rows = () => $$('[data-src]', card);
    const read = (row) => ({ enabled: $('[data-f=enabled]', row).checked, intervalSec: Number($('[data-f=intervalSec]', row).value) });
    const changes = () => {
      const patch = {};
      for (const row of rows()) {
        const name = row.dataset.src;
        const now = read(row);
        if (now.enabled !== original[name].enabled) patch[`sources.${name}.enabled`] = now.enabled;
        if (now.intervalSec !== original[name].intervalSec) patch[`sources.${name}.intervalSec`] = now.intervalSec;
      }
      return patch;
    };
    const refresh = () => {
      for (const row of rows()) {
        const v = read(row);
        const o = original[row.dataset.src];
        row.classList.toggle('changed', v.enabled !== o.enabled || v.intervalSec !== o.intervalSec);
        $('[data-hint]', row).textContent = Number.isFinite(v.intervalSec) && v.intervalSec > 0 ? every(v.intervalSec) : '';
      }
      const n = Object.keys(changes()).length;
      if (!writable) return;
      $('[data-save]', card).disabled = $('[data-reset]', card).disabled = !n;
      $('[data-status]', card).textContent = n ? `${n} unsaved ${n === 1 ? 'change' : 'changes'}` : '';
    };
    card.addEventListener('input', refresh);
    card.addEventListener('change', refresh);

    $('[data-reset]', card)?.addEventListener('click', () => route());
    $('[data-save]', card)?.addEventListener('click', async () => {
      const patch = changes();
      $$('.field-error', card).forEach((f) => (f.textContent = ''));
      rows().forEach((row) => row.classList.remove('invalid'));
      $('[data-save]', card).disabled = true;
      try {
        const res = await api('PATCH', '/settings', patch);
        S.settings = res.settings;
        toast(`Saved ${res.changed.length} ${res.changed.length === 1 ? 'change' : 'changes'}.`);
        route();
      } catch (err) {
        for (const [key, msg] of Object.entries(err.body?.fields || {})) {
          const row = $(`[data-src="${CSS.escape(key.split('.')[1])}"]`, card);
          // The server's message repeats the source name; the row already shows it.
          if (row) { row.classList.add('invalid'); $('.field-error', row).textContent = /intervalSec$/.test(key) ? `Use ${fmt(min)} to ${fmt(max)} seconds.` : msg; }
        }
        toast(err.message, 'bad');
        refresh();
      }
    });

    card.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-run]');
      if (!b) return;
      const name = b.dataset.run;
      b.disabled = true;
      b.textContent = 'Running…';
      try {
        const x = await api('POST', `/sources/${encodeURIComponent(name)}/run`, {});
        // Update this row in place so unsaved schedule edits aren't lost.
        const row = $(`[data-src="${CSS.escape(name)}"]`, card);
        $('[data-cell=status]', row).innerHTML = statusCell(x.status, true);
        $('[data-cell=count]', row).textContent = fmt(x.status?.count);
        $('[data-cell=last]', row).textContent = ago(x.status?.lastRun);
        toast(`${label(name)}: ${x.status?.ok ? `${fmt(x.status.count)} items` : 'failed'}`, x.status?.ok ? '' : 'bad');
      } catch (err) {
        if (err.status !== 401) toast(err.message, 'bad');
      } finally {
        b.disabled = false;
        b.textContent = 'Run now';
      }
    });
  },

  async storage(el) {
    await loadSettings();
    const s = await api('GET', '/storage');
    const writable = can('storage:write');
    el.innerHTML = `<div class="page-head"><div><h1>Storage & limits</h1><p>How much is kept, for how long, and how hard visitors can hit the public API.</p></div>
        ${writable ? '<div class="row"><button class="btn" id="optimize">Optimize search index</button><button class="btn primary" id="prune">Apply limits now</button></div>' : ''}</div>
      <div class="stats">
        <div class="stat"><b>${bytes(s.dbBytes + s.walBytes)}</b><span>database</span></div>
        <div class="stat"><b>${bytes(s.media.bytes)}</b><span>${fmt(s.media.files)} images</span></div>
        <div class="stat"><b>${compact(s.docs.n)}</b><span>documents, oldest ${s.docs.oldest ? ago(s.docs.oldest) : '—'}</span></div>
        <div class="stat"><b>${compact(s.frontier)}</b><span>URLs known to the crawler</span></div>
        <div class="stat"><b>${compact(s.auditRows)}</b><span>audit entries</span></div>
      </div><div id="stForms"></div>`;
    settingsForm($('#stForms'), group('storage'), { title: 'Retention' });
    settingsForm($('#stForms'), group('limits'), { title: 'Public API limits', intro: 'Per process. With several servers, set the same limits at your load balancer or CDN.' });
    $('#prune')?.addEventListener('click', async () => {
      if (!(await confirmAction({ title: 'Apply storage limits now?', body: 'Documents and images past the limits are deleted permanently. Pinned and edited documents are kept.', confirm: 'Delete what is over the limits', danger: true }))) return;
      await act(() => api('POST', '/storage/prune', {}), (r) => `Deleted ${fmt(r.byAge + r.byCount)} documents and ${fmt(r.images.files + r.evicted)} images.`);
      route();
    });
    $('#optimize')?.addEventListener('click', () => act(() => api('POST', '/storage/optimize', {}), 'Search index optimized.'));
  },

  async users(el) {
    const r = await api('GET', '/users');
    const me = S.session.user;
    const owner = me.role === 'owner';
    const roles = owner ? ['viewer', 'editor', 'admin', 'owner'] : ['viewer', 'editor'];
    el.innerHTML = `<div class="page-head"><div><h1>Users</h1><p>Owners manage everyone; admins manage editors and viewers.</p></div></div>
      <section class="card"><h2>Add a user</h2><form class="row" id="newUser">
        <input type="text" name="username" placeholder="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,31}" aria-label="Username">
        <select name="role" aria-label="Role">${roles.map((x) => `<option ${x === 'editor' ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <button class="btn primary">Create with a temporary password</button></form>
        <p class="help" style="margin-top:8px">Viewers can look but not change anything. Editors manage content and the page. Admins also run the crawler, sources, storage and users. Owners can do everything.</p></section>
      <section class="card"><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Two-factor</th><th>Last sign-in</th><th></th></tr></thead><tbody>
        ${r.users.map((u) => {
          const self = u.id === me.id;
          const manageable = !self && (owner || ROLE_RANK[u.role] < ROLE_RANK.admin);
          return `<tr><td><b>${esc(u.username)}</b>${self ? ' <span class="pill info">you</span>' : ''}${u.disabled ? ' <span class="pill bad">disabled</span>' : ''}${u.mustChangePassword ? ' <span class="pill warn">temporary password</span>' : ''}<span class="sub">added by ${esc(u.createdBy || 'unknown')} ${ago(u.createdAt)}</span></td>
            <td>${manageable ? `<select data-role="${u.id}" aria-label="Role for ${esc(u.username)}">${roles.concat(roles.includes(u.role) ? [] : [u.role]).map((x) => `<option ${x === u.role ? 'selected' : ''}>${x}</option>`).join('')}</select>` : esc(u.role)}</td>
            <td>${u.totpEnabled ? `<span class="pill ok">on</span><span class="sub">${u.recoveryCodesLeft} recovery codes left</span>` : '<span class="pill warn">not set up</span>'}</td>
            <td class="num muted">${ago(u.lastLoginAt)}</td>
            <td>${manageable ? `<div class="row"><button class="btn small" data-act="reset-password" data-id="${u.id}" data-name="${esc(u.username)}">Reset password</button>
              <button class="btn small" data-act="reset-2fa" data-id="${u.id}" data-name="${esc(u.username)}">Reset two-factor</button>
              <button class="btn small" data-act="revoke-sessions" data-id="${u.id}" data-name="${esc(u.username)}">Sign out everywhere</button>
              <button class="btn small ${u.disabled ? '' : 'danger'}" data-act="${u.disabled ? 'enable' : 'disable'}" data-id="${u.id}" data-name="${esc(u.username)}">${u.disabled ? 'Enable' : 'Disable'}</button></div>` : ''}</td></tr>`;
        }).join('')}
      </tbody></table></div></section>`;
    $('#newUser').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await act(() => api('POST', '/users', { username: e.target.username.value.trim(), role: e.target.role.value }));
      showTempPassword(res.user.username, res.temporaryPassword);
    });
    el.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-role]');
      if (!sel) return;
      await act(() => api('PATCH', `/users/${sel.dataset.role}`, { role: sel.value }), 'Role changed. They need to sign in again.').catch(() => route());
      route();
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act: a, id, name } = b.dataset;
      const copy = {
        'reset-password': ['Reset password?', `${esc(name)} gets a new temporary password and is signed out everywhere.`, 'Reset password'],
        'reset-2fa': ['Reset two-factor sign-in?', `${esc(name)} is signed out and must set up an authenticator again. Only do this after confirming who they are.`, 'Reset two-factor'],
        'revoke-sessions': ['Sign out everywhere?', `Ends every session ${esc(name)} has open.`, 'Sign out'],
        disable: ['Disable this account?', `${esc(name)} can't sign in until enabled again. Their sessions end now.`, 'Disable'],
        enable: ['Enable this account?', `${esc(name)} will be able to sign in again.`, 'Enable'],
      }[a];
      if (!(await confirmAction({ title: copy[0], body: copy[1], confirm: copy[2], danger: a !== 'enable' }))) return;
      if (a === 'disable' || a === 'enable') await act(() => api('PATCH', `/users/${id}`, { disabled: a === 'disable' }), `${name} ${a}d.`);
      else {
        const res = await act(() => api('POST', `/users/${id}/${a}`, {}), a === 'reset-password' ? null : 'Done.');
        if (res.temporaryPassword) return showTempPassword(name, res.temporaryPassword);
      }
      route();
    });
  },

  async audit(el) {
    el.innerHTML = `<div class="page-head"><div><h1>Audit log</h1><p>Every sign-in attempt and every change, newest first. Entries can't be edited or deleted from here.</p></div></div>
      <section class="card"><form class="row" id="auditFilter">
        <input type="search" name="action" placeholder="Action, e.g. login or settings" aria-label="Action">
        <input type="search" name="user" placeholder="Username" aria-label="Username">
        <button class="btn">Filter</button></form><div id="auditList" style="margin-top:12px"></div><button class="btn" id="auditMore" hidden>Load older entries</button></section>`;
    let entries = [];
    let filters = { action: '', user: '' };
    const load = async (append = false) => {
      const before = append && entries.length ? entries[entries.length - 1].id : '';
      const r = await api('GET', `/audit?${new URLSearchParams({ ...filters, before })}`);
      entries = append ? entries.concat(r.entries) : r.entries;
      $('#auditList').innerHTML = entries.length ? auditTable(entries) : '<p class="empty">No entries match.</p>';
      $('#auditMore').hidden = r.entries.length < 100;
    };
    $('#auditFilter').addEventListener('submit', (e) => { e.preventDefault(); filters = { action: e.target.action.value.trim(), user: e.target.user.value.trim() }; load(); });
    $('#auditMore').addEventListener('click', () => load(true));
    await load();
  },

  async account(el) {
    const u = S.session.user;
    const s = await api('GET', '/account/sessions');
    el.innerHTML = `<div class="page-head"><div><h1>Your account</h1><p>${esc(u.username)}, ${esc(u.role)}.</p></div></div>
      <div class="grid grid-2">
        <section class="card"><h2>Password</h2>${passwordFormHtml()}</section>
        <section class="card"><h2>Two-factor sign-in</h2>
          ${u.totpEnabled ? `<p><span class="pill ok">on</span> ${u.recoveryCodesLeft} recovery codes left.</p><p class="muted small">If you're running low on recovery codes or changed phones, ask another admin to reset two-factor for you, then set it up again.</p>`
            : '<p><span class="pill warn">off</span> Your account is protected by a password only.</p><button class="btn primary" id="setup2fa">Set up two-factor sign-in</button>'}
        </section>
      </div>
      <section class="card"><h2>Where you're signed in</h2><div class="table-wrap"><table><thead><tr><th>Browser</th><th>IP address</th><th>Signed in</th><th>Last active</th><th></th></tr></thead><tbody>
        ${s.sessions.map((x) => `<tr><td class="trunc">${esc(x.ua || 'Unknown')}</td><td class="mono">${esc(x.ip || '')}</td><td class="num">${when(x.createdAt)}</td><td class="num">${ago(x.lastSeen)}</td>
          <td>${x.id === s.current ? '<span class="pill info">this browser</span>' : `<button class="btn small" data-revoke="${esc(x.id)}">Sign out</button>`}</td></tr>`).join('')}
      </tbody></table></div>${s.sessions.length > 1 ? '<p style="margin-top:12px"><button class="btn danger" id="revokeAll">Sign out all other sessions</button></p>' : ''}</section>`;
    bindPasswordForm($('#pwForm'), () => boot());
    $('#setup2fa')?.addEventListener('click', showEnroll);
    $('#revokeAll')?.addEventListener('click', async () => { await act(() => api('POST', '/account/sessions/revoke', { all: true }), 'Other sessions signed out.'); route(); });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-revoke]');
      if (b) { await act(() => api('POST', '/account/sessions/revoke', { id: b.dataset.revoke }), 'Session signed out.'); route(); }
    });
  },
};

// ---------- crawler tabs ----------

const OUTCOMES = {
  indexed: ['ok', 'indexed'], updated: ['ok', 'updated'], hub: ['info', 'starting page'], sitemap: ['info', 'sitemap'],
  'not-modified': ['', 'not modified'], skipped: ['', 'skipped'], duplicate: ['', 'duplicate'], blocked: ['warn', 'blocked'], error: ['bad', 'error'],
};
const outcomePill = (o) => `<span class="pill ${OUTCOMES[o]?.[0] || ''}">${esc(OUTCOMES[o]?.[1] || o)}</span>`;
const logRow = (e) => `<tr><td class="num muted" title="${esc(new Date(e.at).toISOString())}">${new Date(e.at).toLocaleTimeString()}</td><td>${outcomePill(e.outcome)}</td>
  <td class="num">${e.http ?? e.http_status ?? ''}</td><td class="trunc"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.url)}</a>${e.reason ? `<span class="sub">${esc(e.reason)}</span>` : ''}</td>
  <td class="num muted">${e.ms != null ? `${fmt(e.ms)} ms` : ''}</td><td class="num muted">${e.bytes ? bytes(e.bytes) : ''}</td></tr>`;
const logTable = (rows) => `<div class="table-wrap"><table class="log"><thead><tr><th>Time</th><th>Outcome</th><th>HTTP</th><th>URL and reason</th><th>Took</th><th>Size</th></tr></thead><tbody>${rows.map(logRow).join('')}</tbody></table></div>`;

// Pages fetched per minute over the last hour: one series, bars on a zero baseline.
// Drawn at the container's real pixel width so text stays at its CSS size.
function rateChart(series, width = 600) {
  const w = Math.max(280, Math.round(width)), h = 140, pad = { t: 10, r: 8, b: 22, l: 34 };
  const max = Math.max(4, ...series);
  const nice = Math.ceil(max / 4) * 4;
  const bw = (w - pad.l - pad.r) / series.length;
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / nice);
  const bars = series.map((v, i) => {
    const x = pad.l + i * bw;
    const top = y(v);
    const height = h - pad.b - top;
    const minsAgo = series.length - 1 - i;
    const label = `${v} ${v === 1 ? 'page' : 'pages'} ${minsAgo === 0 ? 'this minute' : `${minsAgo} min ago`}`;
    // Rounded top, square base; the hit area is the full column.
    const r = Math.min(2, height / 2, (bw - 2) / 2);
    const path = height > 0 ? `M${x + 1},${h - pad.b} V${top + r} q0,-${r} ${r},-${r} H${x + bw - 1 - r} q${r},0 ${r},${r} V${h - pad.b} Z` : '';
    return `<g class="bar"><title>${label}</title><rect x="${x}" y="${pad.t}" width="${bw}" height="${h - pad.t - pad.b}" fill="transparent"/>${path ? `<path d="${path}"/>` : ''}</g>`;
  }).join('');
  const grid = [0, nice / 2, nice].map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const total = series.reduce((a, b) => a + b, 0);
  return `<figure class="rate"><figcaption><b>Pages fetched per minute</b><span class="muted small">last 60 minutes, ${fmt(total)} in total</span></figcaption>
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Pages fetched per minute over the last hour; ${fmt(total)} in total, peak ${Math.max(...series)} a minute">
      <g class="grid">${grid}</g><g class="bars">${bars}</g>
      <text class="axis" x="${pad.l}" y="${h - 6}">60 min ago</text><text class="axis" x="${w - pad.r}" y="${h - 6}" text-anchor="end">now</text>
    </svg></figure>`;
}

const CRAWLER_TABS = {
  async status(box, { setState }) {
    const render = async () => {
      const [live, c] = await Promise.all([api('GET', '/crawler/live'), api('GET', '/crawler')]);
      setState(live);
      const q = c.queue;
      box.innerHTML = `<div class="stats">
          <div class="stat"><b>${compact(q.byStatus.queued || 0)}</b><span>queued (${compact(q.readyNow)} ready now)</span></div>
          <div class="stat"><b>${compact(q.byStatus.done || 0)}</b><span>fetched</span></div>
          <div class="stat"><b>${compact(q.byStatus.error || 0)}</b><span>failed</span></div>
          <div class="stat"><b>${compact(q.byStatus.blocked || 0)}</b><span>blocked</span></div>
          <div class="stat"><b>${compact(c.status.hosts)}</b><span>sites seen</span></div>
        </div>
        ${!live.obeyRobots ? '<div class="notice bad"><b>robots.txt is switched off for every site.</b> The crawler fetches pages even where sites ask it not to. <a href="#crawler/settings">Change in Settings</a></div>'
          : live.ignoringRobots.length ? `<div class="notice warn">robots.txt is being ignored for: ${live.ignoringRobots.map(esc).join(', ')}. <a href="#crawler/settings">Change in Settings</a></div>` : ''}
        <section class="card">${rateChart(live.perMinute, box.clientWidth - 38)}</section>
        <div class="grid grid-2">
          <section class="card"><h2>Fetching now <span class="muted small">(${live.inflight.length})</span></h2>
            ${live.inflight.length ? `<div class="table-wrap"><table><tbody>${live.inflight.map((f) => `<tr><td class="trunc">${esc(f.url)}<span class="sub">${esc(f.kind)}</span></td><td class="num muted">${f.seconds}s</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing in flight.</p>'}
            <p class="small muted" style="margin-top:12px">Identifies itself as <code>${esc(live.userAgent)}</code></p></section>
          <section class="card"><h2>Queue by kind</h2><div class="table-wrap"><table><tbody>
            ${Object.entries(q.byKind).map(([k, n]) => `<tr><td>${esc({ hub: 'Starting pages (rechecked)', sitemap: 'Sitemaps (rechecked)', article: 'Articles', page: 'Listing pages' }[k] || k)}</td><td class="num">${fmt(n)}</td></tr>`).join('') || '<tr><td class="muted">Empty.</td></tr>'}
          </tbody></table></div><p style="margin-top:10px"><a href="#crawler/sites">Queues by site</a></p></section>
        </div>
        <section class="card"><div class="row"><h2 style="margin:0">Latest activity</h2><span class="spacer"></span><a href="#crawler/log">Full log</a></div>
          ${live.recent.length ? logTable(live.recent.slice(0, 15)) : '<p class="muted" style="margin-top:10px">No fetches since the server started.</p>'}</section>`;
    };
    await render();
    S.timer = setInterval(() => document.visibilityState === 'visible' && render().catch(() => {}), 5000);
  },

  async log(box, { setState }) {
    api('GET', '/crawler/live').then(setState).catch(() => {});
    const f = new URLSearchParams(sessionStorage.getItem('adm.log') || '');
    box.innerHTML = `<section class="card"><form class="row" id="logFilter">
        <input type="search" name="host" placeholder="Filter by site" value="${esc(f.get('host') || '')}" aria-label="Filter by site">
        <select name="outcome" aria-label="Outcome"><option value="">Every outcome</option>${Object.entries(OUTCOMES).map(([k, [, l]]) => `<option value="${k}" ${f.get('outcome') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn">Filter</button><span class="spacer"></span>
        <label class="toggle small"><input type="checkbox" id="logLive" ${f.get('live') === '0' ? '' : 'checked'}><span>Refresh every 5 seconds</span></label>
      </form><div id="logRows" style="margin-top:12px"><p class="muted">Loading…</p></div><button class="btn" id="logMore" hidden>Older entries</button>
      <p class="help" style="margin-top:10px">Kept for 14 days (at most 200,000 entries).</p></section>`;
    let rows = [];
    const params = () => ({ host: $('#logFilter [name=host]').value.trim(), outcome: $('#logFilter [name=outcome]').value });
    const load = async (older = false) => {
      const p = params();
      sessionStorage.setItem('adm.log', new URLSearchParams({ ...p, live: $('#logLive').checked ? '1' : '0' }).toString());
      const r = await api('GET', `/crawler/log?${new URLSearchParams({ ...p, before: older && rows.length ? rows[rows.length - 1].id : '' })}`);
      rows = older ? rows.concat(r.entries) : r.entries;
      $('#logRows').innerHTML = rows.length ? logTable(rows) : '<p class="empty">No entries match.</p>';
      $('#logMore').hidden = r.entries.length < 100;
    };
    $('#logFilter').addEventListener('submit', (e) => { e.preventDefault(); load(); });
    $('#logMore').addEventListener('click', () => load(true));
    S.timer = setInterval(() => $('#logLive')?.checked && document.visibilityState === 'visible' && rows.length <= 100 && load().catch(() => {}), 5000);
    await load();
  },

  async settings(box) {
    api('GET', '/crawler/live').then((l) => $('#crawlState') && ($('#crawlState').textContent = `${l.state[0].toUpperCase()}${l.state.slice(1)}.`)).catch(() => {});
    const g = S.settings.filter((d) => d.group === 'crawler');
    const sec = (name) => g.filter((d) => d.section === name);
    settingsForm(box, sec('robots'), {
      title: 'robots.txt',
      intro: "Sites use robots.txt to say which pages crawlers may fetch. Switching it off makes the crawler ignore that on every site. Expect some sites to block the crawler's IP, and know that in some places (such as under the EU's text-and-data-mining rules) ignoring it can carry legal risk. To make exceptions for a few sites instead, use <b>Ignore robots.txt</b> in Per-site rules below.",
      beforeSave: async (patch) => {
        if (patch['crawler.obeyRobots'] !== false) return true;
        return confirmAction({ title: 'Ignore robots.txt on every site?', body: 'The crawler will fetch pages on <b>all sites</b> even where their robots.txt asks it not to, and will ignore their Crawl-delay. Your per-site rules, the minimum gap per site and daily page limits still apply.', confirm: 'Ignore robots.txt everywhere', danger: true, typeToConfirm: 'ignore robots' });
      },
    });
    settingsForm(box, sec('identity'), { title: 'Identity', intro: 'How the crawler introduces itself. Site owners see this in their logs and match it in robots.txt.' });
    settingsForm(box, sec('pace'), { title: 'Speed and schedule', intro: 'Times are UTC.' });
    settingsForm(box, sec('fetch'), { title: 'Fetching' });
    settingsForm(box, sec('discovery'), { title: 'Discovery', intro: 'Which links get followed and queued.' });
    settingsForm(box, sec('indexing'), { title: 'What gets indexed', intro: 'Pages are always fetched in full; these decide whether they are stored and searchable.' });
    settingsForm(box, sec('rules'), {
      title: 'Per-site rules',
      intro: "Block a site, slow down, cap pages a day, or skip paths. <b>Ignore robots.txt</b> fetches a site even where its robots.txt says no: use it only for sites you own or have permission to crawl. Ignoring robots.txt gets crawlers banned, and in some places (such as the EU's text-and-data-mining rules) it can carry legal risk. Owner-only, and recorded in the audit log.",
      beforeSave: async (patch) => {
        const next = patch['crawler.hostRules'];
        if (!next) return true;
        const before = new Set((S.settings.find((d) => d.key === 'crawler.hostRules')?.value || []).filter((r) => r.ignoreRobots).map((r) => r.host));
        const added = next.filter((r) => r.ignoreRobots && !before.has(r.host)).map((r) => r.host);
        if (!added.length) return true;
        return confirmAction({ title: 'Ignore robots.txt?', body: `The crawler will fetch pages on <b>${added.map(esc).join(', ')}</b> even where their robots.txt asks it not to. Only do this for sites you own or have permission to crawl.`, confirm: 'Ignore robots.txt for these sites', danger: true, typeToConfirm: 'ignore' });
      },
    });
    settingsForm(box, sec('where'), { title: 'Where to crawl' });
  },

  async sites(box, { writable, setState }) {
    api('GET', '/crawler/live').then(setState).catch(() => {});
    const c = await api('GET', '/crawler');
    box.innerHTML = `${writable ? `<section class="card"><h2>Crawl a page now</h2><form class="row" id="crawlNow"><input type="url" name="url" placeholder="https://example.com/article" required aria-label="URL to crawl"><button class="btn primary">Add to the front of the queue</button></form>
        <p class="help" style="margin-top:8px">It still goes through robots.txt and never fetches private network addresses. To see what would happen without queuing it, use <a href="#crawler/test">Test a URL</a>.</p></section>` : ''}
      <div class="grid grid-2">
        <section class="card"><h2>Busiest queues</h2><div class="table-wrap"><table><thead><tr><th>Site</th><th>Queued</th><th></th></tr></thead><tbody>
          ${c.queue.topHosts.map((h) => `<tr><td>${esc(h.host)}</td><td class="num">${fmt(h.n)}</td><td>${writable ? `<button class="btn small" data-purge="${esc(h.host)}">Clear queue</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing queued.</td></tr>'}
        </tbody></table></div></section>
        <section class="card"><h2>Recent failures</h2>${writable ? '<p><button class="btn small" id="requeueAll">Retry all failed pages</button></p>' : ''}<div class="table-wrap"><table><tbody>
          ${c.queue.recentErrors.slice(0, 10).map((r) => `<tr><td class="trunc"><span>${esc(r.url)}</span><span class="sub">${esc(r.error || `HTTP ${r.http_status}`)}</span></td><td class="num muted">${ago(r.fetched_at)}</td></tr>`).join('') || '<tr><td class="muted">No failures.</td></tr>'}
        </tbody></table></div></section>
      </div>
      <section class="card"><h2>Sites</h2><p class="muted small">The 30 most-crawled sites. Filter to find any other.</p><form class="row" id="hostSearch"><input type="search" name="q" placeholder="Filter by host" aria-label="Filter sites"><button class="btn">Filter</button></form><div id="hostList" style="margin-top:10px"></div></section>`;
    $('#crawlNow', box)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await act(() => api('POST', '/crawler/crawl', { url: e.target.url.value.trim() }), 'Queued at the front.');
      e.target.reset();
    });
    $('#requeueAll', box)?.addEventListener('click', async () => {
      await act(() => api('POST', '/crawler/requeue', {}), (r) => `${fmt(r.requeued)} pages queued again.`);
      route();
    });
    box.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-purge]');
      if (p && (await confirmAction({ title: `Clear the queue for ${p.dataset.purge}?`, body: 'Queued pages from this site are dropped. Starting pages stay and will rediscover new articles.', confirm: 'Clear queue', danger: true }))) {
        await act(() => api('POST', '/crawler/purge', { host: p.dataset.purge }), (r) => `Removed ${fmt(r.removed)} queued pages.`);
        route();
      }
      const rb = e.target.closest('[data-robots]');
      if (rb) {
        const r = await act(() => api('GET', `/crawler/robots?host=${encodeURIComponent(rb.dataset.robots)}`));
        modal(`<h2 id="modalTitle">robots.txt for ${esc(r.host)}</h2>
          <p class="muted small">${r.robots ? `HTTP ${esc(r.robots.robots_status)}, fetched ${ago(r.robots.robots_fetched_at)}` : 'Not fetched yet.'}</p>
          <pre class="robots">${esc(r.robots?.robots || '(empty: everything allowed)')}</pre>
          <div class="form-actions">${writable ? '<button class="btn" id="refetchRobots">Fetch again before the next request</button>' : ''}<button class="btn" data-close>Close</button></div>`, (m) => {
          $('#refetchRobots', m)?.addEventListener('click', async () => {
            await act(() => api('POST', '/crawler/refresh-robots', { host: r.host }), 'robots.txt will be fetched again.');
            $('#modal').close();
          });
        });
      }
    });
    const loadHosts = async (qv = '') => {
      const r = await api('GET', `/crawler/hosts?q=${encodeURIComponent(qv)}&limit=30`);
      $('#hostList', box).innerHTML = `<div class="table-wrap"><table><thead><tr><th>Site</th><th>Pages</th><th>Today</th><th>Queued</th><th>Errors</th><th>robots.txt</th><th></th></tr></thead><tbody>
        ${r.hosts.map((h) => `<tr><td>${esc(h.host)} ${h.trusted ? '<span class="pill info">starting site</span>' : ''}${h.rule?.blocked ? '<span class="pill bad">blocked</span>' : ''}${h.rule?.ignoreRobots ? '<span class="pill warn">ignores robots.txt</span>' : h.rule && !h.rule.blocked ? '<span class="pill">custom rule</span>' : ''}</td>
          <td class="num">${fmt(h.pages)}</td><td class="num">${fmt(h.fetched_today)}</td><td class="num">${fmt(h.queued)}</td><td class="num">${fmt(h.errors)}</td>
          <td>${h.robots_status ? `<span class="pill ${h.robots_status < 400 ? 'ok' : h.robots_status < 500 ? '' : 'bad'}">${h.robots_status}</span>` : ''}${h.crawl_delay_ms ? `<span class="muted small">delay ${h.crawl_delay_ms / 1000}s</span>` : ''}</td>
          <td><button class="btn small" data-robots="${esc(h.host)}">View robots.txt</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No sites match.</td></tr>'}
      </tbody></table></div>`;
    };
    $('#hostSearch', box).addEventListener('submit', (e) => { e.preventDefault(); loadHosts(e.target.q.value.trim()); });
    await loadHosts();
  },

  async test(box, { writable, setState }) {
    api('GET', '/crawler/live').then(setState).catch(() => {});
    box.innerHTML = `<section class="card"><h2>Test a URL</h2>
      <p class="muted">Fetches one page the way the crawler would and explains every decision: never-crawl list, patterns, site rules, robots.txt, the fetch, extraction, and whether it would be indexed. Nothing is saved or queued.</p>
      ${writable ? `<form class="row" id="testForm"><input type="url" name="url" placeholder="https://example.com/article" required aria-label="URL to test"><button class="btn primary">Test</button></form>` : '<p class="notice info">Admins and owners can run tests.</p>'}
      <div id="testOut" style="margin-top:14px"></div></section>`;
    $('#testForm', box)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button', e.target);
      btn.disabled = true;
      $('#testOut', box).innerHTML = '<p class="muted">Fetching…</p>';
      try {
        const r = await api('POST', '/crawler/inspect', { url: e.target.url.value.trim() });
        const x = r.extracted;
        $('#testOut', box).innerHTML = `<ul class="checks test-steps">${r.steps.map((s) => `<li class="${s.ok ? 'ok' : 'no'}"><span class="mark">${s.ok ? '✓' : '✗'}</span><span><b>${esc(s.label)}</b><br><span class="muted small">${esc(s.detail)}</span></span></li>`).join('')}</ul>
          ${x ? `<h2 style="margin-top:18px">What the crawler extracted</h2><div class="table-wrap"><table class="kv"><tbody>
            <tr><th>Title</th><td>${esc(x.title)}</td></tr><tr><th>Description</th><td>${esc(x.description)}</td></tr>
            <tr><th>Canonical URL</th><td class="mono small">${esc(x.canonical)}</td></tr><tr><th>Published</th><td>${x.publishedAt ? when(x.publishedAt) : 'unknown'}</td></tr>
            <tr><th>Author</th><td>${esc(x.author || 'unknown')}</td></tr><tr><th>Language</th><td>${esc(x.lang || 'unknown')}</td></tr>
            <tr><th>Words</th><td>${fmt(x.words)}${x.isArticle ? ' (looks like an article)' : ''}</td></tr><tr><th>Links found</th><td>${fmt(x.links)}</td></tr>
            <tr><th>Images</th><td>${x.images.map((i) => `<div class="small"><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.url.slice(0, 90))}</a>${i.alt ? ` <span class="muted">${esc(i.alt.slice(0, 80))}</span>` : ''}</div>`).join('') || 'none'}</td></tr>
          </tbody></table></div>${x.textPreview ? `<details style="margin-top:10px"><summary class="muted small">Start of the extracted text</summary><pre class="robots">${esc(x.textPreview)}</pre></details>` : ''}` : ''}`;
      } catch (err) {
        $('#testOut', box).innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    });
  },
};

function auditTable(entries) {
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>From</th></tr></thead><tbody>
    ${entries.map((e) => `<tr><td class="num" title="${esc(new Date(e.at).toISOString())}">${when(e.at)}</td><td>${esc(e.username || '—')}</td>
      <td><span class="pill ${/failed/.test(e.action) ? 'bad' : /login\.success/.test(e.action) ? 'ok' : ''}">${esc(e.action)}</span></td>
      <td class="trunc">${esc(e.target || '')}${e.detail ? `<details><summary class="muted small">details</summary><pre class="robots">${esc(JSON.stringify(e.detail, null, 2))}</pre></details>` : ''}</td>
      <td class="mono small">${esc(e.ip || '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function showTempPassword(name, pw) {
  modal(`<h2 id="modalTitle">Temporary password for ${esc(name)}</h2>
    <p>Send it to them over a channel you trust. They'll choose their own password and set up two-factor sign-in when they first sign in.</p>
    <div class="secret-once"><code>${esc(pw)}</code></div>
    <p class="muted small">This is the only time it is shown.</p>
    <div class="form-actions"><button class="btn" id="copyPw">Copy</button><button class="btn primary" data-close>Done</button></div>`, (m) => {
    $('#copyPw', m).addEventListener('click', () => navigator.clipboard?.writeText(pw).then(() => toast('Copied')));
  });
  $('#modal').addEventListener('close', () => route(), { once: true });
}

async function editDoc(id, reload) {
  const d = await act(() => api('GET', `/content/${id}`));
  const writable = can('content:write');
  const removed = d.hidden && d.locked && !d.description && !d.bodyPreview;
  const dis = writable && !removed ? '' : 'disabled';
  modal(`<h2 id="modalTitle">Edit document</h2>
    <p class="small"><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url)}</a></p>
    <p class="muted small">${esc(d.type)} from ${esc(d.site)}${d.publishedAt ? `, published ${when(d.publishedAt)}` : ''}${d.crawledAt ? `, crawled ${ago(d.crawledAt)}` : ''}${d.editedBy ? `. Last edited by ${esc(d.editedBy)} ${ago(d.editedAt)}` : ''}.</p>
    ${removed ? '<div class="notice bad">Removed. Its text and images were deleted; restoring makes the headline visible again and lets crawlers fill it back in.</div>' : ''}
    <form id="docForm" class="grid" novalidate>
      <label class="field"><span>Headline</span><input type="text" name="title" value="${esc(d.title)}" maxlength="300" ${dis}></label>
      <label class="field"><span>Summary</span><textarea name="description" rows="4" maxlength="1000" ${dis}>${esc(d.description)}</textarea><small>Editing either locks them: crawlers won't overwrite your text.</small></label>
      <div class="row">
        <label class="toggle"><input type="checkbox" name="pinned" ${d.pinned ? 'checked' : ''} ${dis}><span>Pin to the top of the front page</span></label>
        <label class="toggle"><input type="checkbox" name="hidden" ${d.hidden ? 'checked' : ''} ${writable && !removed ? '' : 'disabled'}><span>Hide from the site and search</span></label>
        ${d.locked && !removed ? `<label class="toggle"><input type="checkbox" name="locked" checked ${dis}><span>Keep my edits (uncheck to let crawlers update it)</span></label>` : ''}
      </div>
      ${d.bodyPreview ? `<details><summary class="muted small">Stored text (${fmt(d.words)} words)</summary><pre class="robots">${esc(d.bodyPreview)}</pre></details>` : ''}
      <div class="form-actions">
        ${writable ? (removed ? '<button class="btn primary" type="button" id="restore">Restore</button>' : '<button class="btn primary" type="submit">Save</button><button class="btn danger" type="button" id="removeDoc">Remove permanently</button>') : ''}
        <button class="btn" type="button" data-close>Close</button>
      </div>
    </form>`, (m) => {
    const f = $('#docForm', m);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {};
      if (f.title.value.trim() !== d.title) patch.title = f.title.value.trim();
      if (f.description.value.trim() !== (d.description || '')) patch.description = f.description.value.trim();
      if (f.pinned.checked !== d.pinned) patch.pinned = f.pinned.checked;
      if (f.hidden.checked !== d.hidden) patch.hidden = f.hidden.checked;
      if (f.locked && !f.locked.checked) patch.locked = false;
      if (!Object.keys(patch).length) return $('#modal').close();
      try {
        await api('PATCH', `/content/${d.id}`, patch);
        toast('Saved. The front page updates within a few seconds.');
        $('#modal').close();
        reload();
      } catch (err) {
        formError(f, err.message);
      }
    });
    $('#restore', m)?.addEventListener('click', async () => {
      await act(() => api('PATCH', `/content/${d.id}`, { hidden: false, locked: false }), 'Restored.');
      $('#modal').close();
      reload();
    });
    $('#removeDoc', m)?.addEventListener('click', async () => {
      $('#modal').close();
      if (!(await confirmAction({ title: 'Remove permanently?', body: `The stored text and images for "${esc(d.title)}" are deleted. A hidden placeholder stays so feeds can't bring it back.`, confirm: 'Remove', danger: true, typeToConfirm: 'remove' }))) return;
      await act(() => api('POST', `/content/${d.id}/remove`, {}), 'Removed.');
      reload();
    });
  });
}

// ---------- boot ----------

async function boot() {
  let s;
  try {
    s = await api('GET', '/session');
  } catch (e) {
    return authCard(`<h1>Admin is unavailable</h1><p class="notice bad">${esc(e.message)}</p>`);
  }
  S.session = s;
  if (s.setupRequired) return showSetupRequired();
  if (s.state === 'anonymous') return showLogin();
  if (s.state === 'mfa') return showMfa();
  if (s.state === 'enroll') return showEnroll();
  if (s.state === 'password') return showForcedPassword();
  shell();
  route();
}

boot();
