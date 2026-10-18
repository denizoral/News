// End-to-end security tests for the admin API and public hardening. Boots the
// real HTTP server on a random port against an in-memory database.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, q } from '../src/db.js';
import { settings } from '../src/settings.js';
import { _setKeyForTests } from '../src/security/secretbox.js';
import { totpAt, base32Encode, verifyTotp } from '../src/security/totp.js';
import { hashPassword, verifyPassword, passwordProblem } from '../src/security/passwords.js';
import { assertPublicUrl, isPublicAddress } from '../src/security/ssrf.js';
import { parseAllowlist } from '../src/security/httpkit.js';
import { createUser } from '../src/admin/auth.js';
import { upsertDoc } from '../src/index/documents.js';
import { Store } from '../src/store.js';
import { Spider } from '../src/spider/engine.js';
import { createApp } from '../src/server.js';

resetDb();
_setKeyForTests(crypto.randomBytes(32));
settings.load();

const store = new Store();
const spider = new Spider();
const server = createApp({ store, spider });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// Minimal cookie-jar client.
function client() {
  const jar = {};
  let csrf = null;
  const call = async (method, path, body, { headers = {}, origin = base, noCsrf = false } = {}) => {
    const h = { ...headers };
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      h['content-type'] ??= 'application/json';
      if (origin) h.origin = origin;
      if (csrf && !noCsrf) h['x-csrf-token'] ??= csrf;
    }
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const [k, v] = kv.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a))) delete jar[k];
      else jar[k] = v;
    }
    let data = null;
    try { data = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, data, headers: res.headers, res };
  };
  return {
    jar, call,
    async refresh() { const r = await call('GET', '/api/admin/session'); csrf = r.data.csrf || null; return r.data; },
    setCsrf(v) { csrf = v; },
  };
}

const step = () => Math.floor(Date.now() / 30000);

test('passwords, TOTP and recovery primitives', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal((await verifyPassword('correct horse battery staple', h)).ok, true);
  assert.equal((await verifyPassword('wrong', h)).ok, false);
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('password1234'.slice(0, 8) + 'password'));
  assert.ok(passwordProblem('aliceisgreat123', 'alice'));
  assert.equal(passwordProblem('a perfectly fine passphrase'), null);
  // RFC 6238 test vector (SHA-1, T=59s => 94287082, last 6 digits).
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, 1), '287082');
  assert.equal(verifyTotp(secret, '287082', { now: 59000 }), 1);
  assert.equal(verifyTotp(secret, '287082', { now: 59000, lastStep: 1 }), null, 'replay of the same step is refused');
});

test('SSRF guard blocks private and internal targets', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('8.8.8.8'), true, 'IPv4 is not caught by IPv6 rules');
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false, 'mapped loopback');
  assert.equal(isPublicAddress('::ffff:169.254.169.254'), false, 'mapped metadata address');
  assert.equal(isPublicAddress('::ffff:7f00:1'), false, 'hex mapped form refused');
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:6379/', 'http://[::1]/', 'http://10.0.0.5/admin', 'ftp://example.com/', 'http://user:pw@93.184.216.34/', 'http://93.184.216.34:22/', 'http://db.internal/']) {
    await assert.rejects(assertPublicUrl(u), undefined, u);
  }
  await assertPublicUrl('http://93.184.216.34/');
});

test('IP allowlist parsing', () => {
  const allow = parseAllowlist('203.0.113.0/24, 2001:db8::/32, 198.51.100.7');
  assert.equal(allow('203.0.113.9'), true);
  assert.equal(allow('203.0.114.1'), false);
  assert.equal(allow('2001:db8::1'), true);
  assert.equal(allow('198.51.100.7'), true);
  assert.equal(allow('not-an-ip'), false);
  assert.equal(parseAllowlist(''), null);
  assert.throws(() => parseAllowlist('nonsense'));
});

test('admin API: sign-in, 2FA, CSRF, roles, validation, brute force', async (t) => {
  const anon = client();

  await t.test('no accounts: setup is only possible from the server', async () => {
    const s = await anon.refresh();
    assert.equal(s.setupRequired, true);
    assert.equal(s.state, 'anonymous');
    const r = await anon.call('GET', '/api/admin/overview');
    assert.equal(r.status, 401);
  });

  await createUser({ username: 'owner1', password: 'owner one strong passphrase', role: 'owner' });
  await createUser({ username: 'viewer1', password: 'viewer one strong passphrase', role: 'viewer' });
  await createUser({ username: 'editor1', password: 'editor one strong passphrase', role: 'editor' });

  await t.test('admin pages and API carry strict security headers', async () => {
    const page = await anon.call('GET', '/admin/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
    const api = await anon.call('GET', '/api/admin/session');
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    // Only whitelisted UI files are served; no directory traversal.
    assert.equal((await anon.call('GET', '/admin/../src/db.js')).status, 404);
    assert.equal((await anon.call('GET', '/admin/%2e%2e/package.json')).status, 404);
  });

  await t.test('login failures look the same for unknown users and wrong passwords', async () => {
    const a = await anon.call('POST', '/api/admin/login', { username: 'nobody', password: 'whatever whatever' });
    const b = await anon.call('POST', '/api/admin/login', { username: 'owner1', password: 'wrong wrong wrong' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.data.error, b.data.error);
    const logged = q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed'").get().n;
    assert.ok(logged >= 2, 'failed sign-ins are audited');
  });

  await t.test('cross-site login attempts are refused', async () => {
    const r = await anon.call('POST', '/api/admin/login', { username: 'owner1', password: 'owner one strong passphrase' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const r2 = await anon.call('POST', '/api/admin/login', { username: 'owner1', password: 'owner one strong passphrase' }, { origin: null });
    assert.equal(r2.status, 403);
  });

  await t.test('only JSON bodies of bounded size are accepted', async () => {
    const r = await anon.call('POST', '/api/admin/login', 'username=owner1&password=x', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
    const big = await anon.call('POST', '/api/admin/login', { username: 'x', password: 'y'.repeat(10000) });
    assert.equal(big.status, 413);
    const bad = await anon.call('POST', '/api/admin/login', '{not json');
    assert.equal(bad.status, 400);
  });

  const owner = client();
  let secret;

  await t.test('first sign-in requires 2FA enrollment before anything else', async () => {
    const r = await owner.call('POST', '/api/admin/login', { username: 'owner1', password: 'owner one strong passphrase' });
    assert.equal(r.status, 200);
    assert.equal(r.data.next, 'enroll');
    const cookie = r.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    // Only a hash of the token is stored.
    const token = Object.values(owner.jar)[0];
    assert.equal(q('SELECT COUNT(*) AS n FROM admin_sessions WHERE id_hash = ?').get(token).n, 0);
    const s = await owner.refresh();
    assert.equal(s.state, 'enroll');
    const blocked = await owner.call('GET', '/api/admin/overview');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.next, 'enroll');
  });

  await t.test('state changes without the CSRF token are refused', async () => {
    const r = await owner.call('POST', '/api/admin/account/totp/begin', {}, { noCsrf: true });
    assert.equal(r.status, 403);
    const r2 = await owner.call('POST', '/api/admin/account/totp/begin', {}, { headers: { 'x-csrf-token': 'forged-token-value-of-similar-len' } });
    assert.equal(r2.status, 403);
  });

  await t.test('enrolls an authenticator and gets recovery codes', async () => {
    const b = await owner.call('POST', '/api/admin/account/totp/begin', {});
    assert.equal(b.status, 200);
    assert.match(b.data.qr, /^<svg/);
    secret = b.data.secret;
    const wrong = await owner.call('POST', '/api/admin/account/totp/confirm', { code: '000000' });
    assert.equal(wrong.status, 400);
    const ok = await owner.call('POST', '/api/admin/account/totp/confirm', { code: totpAt(secret, step()) });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.recoveryCodes.length, 10);
    const stored = q("SELECT totp_secret FROM admin_users WHERE username = 'owner1'").get().totp_secret;
    assert.ok(stored.startsWith('v1.') && !stored.includes(secret), 'TOTP secret is encrypted at rest');
    assert.equal((await owner.call('GET', '/api/admin/overview')).status, 200);
  });

  const owner2 = client();
  await t.test('later sign-ins need the code; codes cannot be replayed', async () => {
    const r = await owner2.call('POST', '/api/admin/login', { username: 'owner1', password: 'owner one strong passphrase' });
    assert.equal(r.data.next, 'mfa');
    await owner2.refresh();
    assert.equal((await owner2.call('GET', '/api/admin/overview')).status, 401);
    assert.equal((await owner2.call('POST', '/api/admin/login/mfa', { code: '123456' })).status, 401);
    // The current step was already used during enrollment; the next one works once.
    const code = totpAt(secret, step() + 1);
    const ok = await owner2.call('POST', '/api/admin/login/mfa', { code });
    assert.equal(ok.status, 200);
    await owner2.refresh();
    assert.equal((await owner2.call('GET', '/api/admin/overview')).status, 200);
    const again = client();
    await again.call('POST', '/api/admin/login', { username: 'owner1', password: 'owner one strong passphrase' });
    assert.equal((await again.call('POST', '/api/admin/login/mfa', { code })).status, 401, 'same code refused the second time');
  });

  await t.test('settings are validated against the schema', async () => {
    await owner2.refresh();
    const bad = await owner2.call('PATCH', '/api/admin/settings', { 'crawler.concurrency': 9999, 'nope.key': 1, 'site.bannerLink': 'javascript:alert(1)' });
    assert.equal(bad.status, 400);
    assert.ok(bad.data.fields['crawler.concurrency']);
    assert.ok(bad.data.fields['nope.key']);
    assert.ok(bad.data.fields['site.bannerLink']);
    assert.equal(settings.get('crawler.concurrency') !== 9999, true, 'nothing saved when any field is invalid');
    const rules = await owner2.call('PATCH', '/api/admin/settings', { 'crawler.hostRules': [{ host: 'bad host!', blocked: true }] });
    assert.equal(rules.status, 400);
    const ok = await owner2.call('PATCH', '/api/admin/settings', { 'crawler.maxDepth': 2, 'site.banner': '<b>Hi</b>', 'crawler.hostRules': [{ host: 'Example.com', blocked: false, minDelayMs: 5000, disallow: ['/private/'] }] });
    assert.equal(ok.status, 200);
    assert.equal(settings.get('crawler.maxDepth'), 2);
    assert.equal(settings.get('crawler.hostRules')[0].host, 'example.com');
    assert.equal(spider.cfg.maxDepth, 2, 'spider picks up changes live');
    assert.equal(spider.ruleDisallows('https://example.com/private/x'), true);
    assert.ok(q("SELECT 1 FROM audit_log WHERE action = 'settings.update'").get(), 'settings changes are audited');
  });

  await t.test('roles are enforced server-side', async () => {
    const viewer = client();
    await viewer.call('POST', '/api/admin/login', { username: 'viewer1', password: 'viewer one strong passphrase' });
    // Enroll quickly so the viewer has a full session.
    await viewer.refresh();
    const b = await viewer.call('POST', '/api/admin/account/totp/begin', {});
    await viewer.call('POST', '/api/admin/account/totp/confirm', { code: totpAt(b.data.secret, step()) });
    assert.equal((await viewer.call('GET', '/api/admin/overview')).status, 200);
    assert.equal((await viewer.call('PATCH', '/api/admin/settings', { 'site.name': 'Pwned' })).status, 403);
    assert.equal((await viewer.call('GET', '/api/admin/users')).status, 403);
    assert.equal((await viewer.call('GET', '/api/admin/audit')).status, 403);
    assert.equal((await viewer.call('POST', '/api/admin/crawler/crawl', { url: 'https://example.com/' })).status, 403);

    const editor = client();
    await editor.call('POST', '/api/admin/login', { username: 'editor1', password: 'editor one strong passphrase' });
    await editor.refresh();
    const eb = await editor.call('POST', '/api/admin/account/totp/begin', {});
    await editor.call('POST', '/api/admin/account/totp/confirm', { code: totpAt(eb.data.secret, step()) });
    const er = await editor.call('PATCH', '/api/admin/settings', { 'site.name': 'Wire', 'crawler.concurrency': 2 });
    assert.equal(er.status, 400);
    assert.match(er.data.fields['crawler.concurrency'], /admin/);
    assert.equal((await editor.call('PATCH', '/api/admin/settings', { 'site.name': 'Wire' })).status, 200);
    // Admins and editors can't mint owners.
    assert.equal((await editor.call('POST', '/api/admin/users', { username: 'sneaky', role: 'owner' })).status, 403);
  });

  await t.test('users: temporary passwords, last-owner protection', async () => {
    await owner2.refresh();
    const c = await owner2.call('POST', '/api/admin/users', { username: 'newbie', role: 'editor' });
    assert.equal(c.status, 200);
    assert.ok(c.data.temporaryPassword.length >= 20);
    const me = q("SELECT id FROM admin_users WHERE username = 'owner1'").get().id;
    assert.equal((await owner2.call('PATCH', `/api/admin/users/${me}`, { disabled: true })).status, 400, 'cannot change self here');
    const nb = q("SELECT id FROM admin_users WHERE username = 'newbie'").get().id;
    assert.equal((await owner2.call('PATCH', `/api/admin/users/${nb}`, { role: 'superuser' })).status, 400);
  });

  await t.test('content moderation reaches the public site and survives re-ingest', async () => {
    const { id } = upsertDoc({ url: 'https://news.example.com/a-story', type: 'article', title: 'Original headline about Claude', description: 'x', body: 'Claude text body', site: 'news.example.com', published_at: Date.now() });
    await owner2.refresh();
    const e = await owner2.call('PATCH', `/api/admin/content/${id}`, { title: 'Corrected headline about Claude' });
    assert.equal(e.status, 200);
    assert.equal(e.data.locked, true);
    upsertDoc({ url: 'https://news.example.com/a-story', type: 'article', title: 'Original headline about Claude', site: 'news.example.com', fetched_at: Date.now(), body: 'longer crawled body about Claude' });
    assert.equal(q('SELECT title FROM docs WHERE id = ?').get(id).title, 'Corrected headline about Claude', 'crawler cannot overwrite an edit');
    const pub = await (await fetch(`${base}/api/search?q=corrected`)).json();
    assert.equal(pub.results.length, 1);
    await owner2.call('PATCH', `/api/admin/content/${id}`, { hidden: true });
    const hidden = await (await fetch(`${base}/api/search?q=corrected&nocache=1`)).json();
    assert.equal(hidden.results.length, 0, 'hidden documents leave public search');
    const rm = await owner2.call('POST', `/api/admin/content/${id}/remove`, {});
    assert.equal(rm.status, 200);
    upsertDoc({ url: 'https://news.example.com/a-story', type: 'article', title: 'Back again', description: 'resurrected', site: 'news.example.com' });
    const row = q('SELECT title, description, hidden FROM docs WHERE id = ?').get(id);
    assert.equal(row.hidden, 1);
    assert.equal(row.description, '', 'removed documents stay removed');
  });

  await t.test('brute force on one account is throttled', async () => {
    const atk = client();
    let last;
    for (let i = 0; i < 10; i++) last = await atk.call('POST', '/api/admin/login', { username: 'editor1', password: `guess number ${i}` });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });

  await t.test('sign-out ends the session server-side', async () => {
    const r = await owner2.call('POST', '/api/admin/logout', {});
    assert.equal(r.status, 200);
    const after = await owner2.call('GET', '/api/admin/overview');
    assert.equal(after.status, 401);
  });
});

test('public site hardening', async () => {
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400, 'malformed escapes do not crash the server');
  assert.equal((await fetch(`${base}/../package.json`)).status !== 200 || !(await (await fetch(`${base}/../package.json`)).text()).includes('"dependencies"'), true);
  assert.equal((await fetch(`${base}/api/search?q=${'a'.repeat(300)}`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?q=x&page=9999`)).status, 400);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /User-agent/);

  settings.update({ 'limits.searchPerMinute': 10 }, { role: 'owner', actor: 'test' });
  let last;
  for (let i = 0; i < 15; i++) last = await fetch(`${base}/api/suggest?q=claude${i}`);
  assert.equal(last.status, 429);
});
