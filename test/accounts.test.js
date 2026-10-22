// Reader accounts, the admin app's bearer sign-in, Google ID tokens, Firebase
// sending and the push rules. Boots the real server against an in-memory DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, q } from '../src/db.js';
import { settings } from '../src/settings.js';
import { _setKeyForTests } from '../src/security/secretbox.js';
import { totpAt, base32Encode } from '../src/security/totp.js';
import { createUser } from '../src/admin/auth.js';
import { Store } from '../src/store.js';
import { Spider } from '../src/spider/engine.js';
import { createApp } from '../src/server.js';
import { verifyGoogleIdToken, resetGoogleKeys } from '../src/accounts/google.js';
import { sendFcm, resetFcm } from '../src/push/fcm.js';
import { followMatch, inQuiet, pushFollows, pushBreakingMobile, pushChangelog, readChangelog, registerDevice } from '../src/push/mobile.js';
import { cleanPrefs } from '../src/accounts/users.js';

resetDb();
_setKeyForTests(crypto.randomBytes(32));
settings.load();
const server = createApp({ store: new Store(), spider: new Spider() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const DEVICE = (n) => `dev${n}:${'x'.repeat(60)}`;

test('reader accounts: sign up, sign in, prefs, password change ends old sessions, delete', async () => {
  const weak = await call('POST', '/api/user/signup', { email: 'a@example.com', password: 'short' });
  assert.equal(weak.status, 400);
  const up = await call('POST', '/api/user/signup', { email: 'A@Example.com', password: 'correct horse battery', name: 'Ada' });
  assert.equal(up.status, 200);
  assert.match(up.data.token, /^fwu_/);
  assert.equal(up.data.user.email, 'a@example.com');
  assert.equal((await call('POST', '/api/user/signup', { email: 'a@example.com', password: 'correct horse battery' })).status, 409);
  // Bearer only: no cookies are ever set.
  assert.equal(up.headers.get('set-cookie'), null);

  const bad = await call('POST', '/api/user/login', { email: 'a@example.com', password: 'wrong password here' });
  const none = await call('POST', '/api/user/login', { email: 'nobody@example.com', password: 'wrong password here' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, none.data.error, 'unknown emails fail the same way');
  const inn = await call('POST', '/api/user/login', { email: 'a@example.com', password: 'correct horse battery' });
  assert.equal(inn.status, 200);
  const t = inn.data.token;

  assert.equal((await call('GET', '/api/user')).status, 401);
  assert.equal((await call('GET', '/api/user', null, bearer(t))).data.user.name, 'Ada');
  const p = await call('PUT', '/api/user/prefs', { follows: { names: [{ key: 'OpenAI', label: 'OpenAI' }, { key: 'openai' }], topics: [{ key: 'chips' }] }, alerts: { minOutlets: 5, quiet: { from: 22, to: 7, tz: 60 }, bogus: 1 } }, bearer(t));
  assert.deepEqual(p.data.prefs.follows.names, [{ key: 'openai', label: 'OpenAI' }]);
  assert.equal(p.data.prefs.alerts.minOutlets, 5);
  assert.deepEqual(p.data.prefs.alerts.quiet, { from: 22, to: 7, tz: 60 });
  assert.equal(p.data.prefs.alerts.bogus, undefined);
  // Not JSON: refused (a form post from another site can't get this far).
  const form = await fetch(`${base}/api/user/prefs`, { method: 'PUT', headers: { ...bearer(t), 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);

  const pw = await call('POST', '/api/user/password', { current: 'correct horse battery', next: 'another long passphrase' }, bearer(t));
  assert.equal(pw.status, 200);
  assert.equal((await call('GET', '/api/user', null, bearer(up.data.token))).status, 401, 'older sessions end');
  assert.equal((await call('GET', '/api/user', null, bearer(pw.data.token))).status, 200);
  assert.equal((await call('POST', '/api/user/delete', { password: 'another long passphrase' }, bearer(pw.data.token))).status, 200);
  assert.equal(q('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('devices: anonymous and signed-in installs register, bad tokens are refused', async () => {
  assert.equal((await call('POST', '/api/devices', { token: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/devices', { token: DEVICE(1) })).status, 200);
  const up = await call('POST', '/api/user/signup', { email: 'd@example.com', password: 'correct horse battery' });
  await call('POST', '/api/devices', { token: DEVICE(2) }, bearer(up.data.token));
  assert.equal(q('SELECT user_id FROM devices WHERE token = ?').get(DEVICE(2)).user_id, up.data.user.id);
  assert.equal(q('SELECT user_id FROM devices WHERE token = ?').get(DEVICE(1)).user_id, null);
  assert.equal((await call('POST', '/api/devices/remove', { token: DEVICE(1) })).data.ok, true);
});

test('admin app: password and TOTP give a bearer token, which needs no CSRF and reaches the changelog', async () => {
  const u = await createUser({ username: 'owner1', password: 'a very long admin pass', role: 'owner' });
  const secret = base32Encode(crypto.randomBytes(20));
  const { seal } = await import('../src/security/secretbox.js');
  q('UPDATE admin_users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(seal(secret), u.id);
  const app = { 'x-client': 'wire-admin-app' };
  // Without the app header and without an Origin, a sign-in is refused.
  assert.equal((await call('POST', '/api/admin/login', { username: 'owner1', password: 'a very long admin pass' })).status, 403);
  const l = await call('POST', '/api/admin/login', { username: 'owner1', password: 'a very long admin pass' }, app);
  assert.equal(l.status, 200);
  assert.equal(l.data.next, 'mfa');
  assert.ok(l.data.token);
  assert.equal(l.headers.get('set-cookie'), null, 'the app gets no cookie');
  assert.equal((await call('GET', '/api/admin/changelog', null, bearer(l.data.token))).status, 401, 'half-signed-in');
  const m = await call('POST', '/api/admin/login/mfa', { code: totpAt(secret, Math.floor(Date.now() / 30e3)) }, { ...app, ...bearer(l.data.token) });
  assert.equal(m.status, 200);
  const full = bearer(m.data.token);
  const c = await call('GET', '/api/admin/changelog', null, full);
  assert.equal(c.status, 200);
  assert.ok(c.data.entries.length > 5 && c.data.entries[0].date && c.data.entries[0].title);
  // A state-changing call with the bearer token and no CSRF header works.
  assert.equal((await call('POST', '/api/admin/devices', { token: DEVICE(9) }, full)).status, 200);
  assert.equal(q('SELECT admin_user_id FROM devices WHERE token = ?').get(DEVICE(9)).admin_user_id, u.id);
  assert.equal((await call('GET', '/api/admin/readers', null, full)).data.devices.admin, 1);
});

test('Google ID tokens: signature, audience, expiry and a verified email', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fetcher = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=600' } });
  const sign = (claims, key = privateKey) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = enc({ alg: 'RS256', kid: 'k1' });
    const b = enc(claims);
    return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), key).toString('base64url')}`;
  };
  const now = Date.now();
  const good = { iss: 'https://accounts.google.com', aud: 'web-client', sub: '123', email: 'g@example.com', email_verified: true, exp: now / 1000 + 600, iat: now / 1000 };
  resetGoogleKeys();
  const c = await verifyGoogleIdToken(sign(good), { audiences: ['web-client'], fetcher });
  assert.deepEqual(c, { sub: '123', email: 'g@example.com', name: '' });
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, aud: 'other' }), { audiences: ['web-client'], fetcher }), /expired or isn’t for this app/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, exp: now / 1000 - 3600 }), { audiences: ['web-client'], fetcher }), /expired/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, email_verified: false }), { audiences: ['web-client'], fetcher }), /verified/);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyGoogleIdToken(sign(good, other), { audiences: ['web-client'], fetcher }), /isn’t valid/);
  await assert.rejects(verifyGoogleIdToken(sign(good), { audiences: [], fetcher }), /isn’t set up/);
});

test('Firebase: signs a token request, sends, and reports uninstalled apps', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  resetFcm({ project_id: 'proj', client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    const msg = JSON.parse(init.body).message;
    if (msg.token === 'gone') return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    return new Response('{}');
  };
  assert.equal(await sendFcm('tok', { title: 'Breaking', body: 'Hi', data: { sid: 'abc', n: 3 }, channel: 'breaking', collapse: 'story-abc' }, { fetcher }), 'ok');
  assert.equal(await sendFcm('gone', { title: 'x', body: 'y' }, { fetcher }), 'gone');
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'the access token is reused');
  const sent = JSON.parse(calls[1].init.body).message;
  assert.equal(sent.android.priority, 'high');
  assert.deepEqual(sent.data, { sid: 'abc', n: '3' });
  assert.match(calls[1].url, /projects\/proj\/messages:send$/);
  resetFcm(undefined);
});

test('push rules: follows, outlet threshold, once per story, quiet hours, breaking for everyone', async () => {
  resetDb();
  const prefs = cleanPrefs({ follows: { names: [{ key: 'nvidia', label: 'Nvidia' }], accounts: [{ key: 'sama' }] }, alerts: { minOutlets: 2 } });
  const r = q("INSERT INTO users (email, created_at, prefs) VALUES ('p@example.com', 1, ?)").run(JSON.stringify(prefs));
  registerDevice({ token: DEVICE(3), app: 'wire', userId: Number(r.lastInsertRowid) });
  registerDevice({ token: DEVICE(4), app: 'wire' }); // anonymous: breaking only
  const now = Date.now();
  const src = (host) => ({ platform: 'web', host, name: host });
  const stories = [
    { sid: 's1', title: 'Nvidia ships a chip', entities: ['nvidia'], publishedAt: now - 3600e3, sources: [src('a.com')] },
    { sid: 's2', title: 'Nvidia earnings', entities: ['nvidia'], publishedAt: now - 3600e3, sources: [src('a.com'), src('b.com'), src('c.com')] },
    { sid: 's3', title: 'Something else', entities: ['apple'], publishedAt: now - 3600e3, sources: [src('a.com'), src('b.com')] },
  ];
  assert.equal(followMatch({ sources: [{ platform: 'x', name: '@sama' }] }, prefs.follows), '@sama');
  const sent = [];
  const send = async (token, msg) => { sent.push([token, msg]); return 'ok'; };
  assert.equal(await pushFollows(stories, { now, send, enabled: true }), 1);
  assert.deepEqual(sent.map(([t, m]) => [t, m.data.sid, m.title]), [[DEVICE(3), 's2', 'Nvidia']]);
  assert.equal(await pushFollows(stories, { now: now + 20 * 60e3, send, enabled: true }), 0, 'never the same story twice; s1 is below the outlet threshold');
  assert.equal(await pushBreakingMobile([{ sid: 's3', title: 'Something else', peak: 9 }], stories, { now, send, enabled: true }), 2);
  assert.equal(await pushBreakingMobile([{ sid: 's3', title: 'Something else', peak: 9 }], stories, { now, send, enabled: true }), 0);
  assert.equal(await pushFollows(stories, { now, send, enabled: false }), 0, 'off without Firebase');
  assert.equal(inQuiet({ from: 22, to: 7, tz: 0 }, Date.parse('2026-10-22T23:30:00Z')), true);
  assert.equal(inQuiet({ from: 22, to: 7, tz: 120 }, Date.parse('2026-10-22T19:30:00Z')), false);
  assert.equal(inQuiet({ from: 22, to: 7, tz: 120 }, Date.parse('2026-10-22T20:30:00Z')), true);
});

test('changelog: FEATURES.md entries reach admin devices once', async () => {
  const entries = readChangelog();
  assert.ok(entries.some((e) => e.title === 'Rumor mill' && e.route === '#rumors'));
  resetDb();
  const u = await createUser({ username: 'owner2', password: 'a very long admin pass', role: 'owner' });
  registerDevice({ token: DEVICE(5), app: 'admin', adminUserId: u.id });
  const sent = [];
  const send = async (t, m) => { sent.push(m); return 'ok'; };
  const today = new Date().toISOString().slice(0, 10);
  const list = [{ id: `${today}:x`, date: today, title: 'X', body: '**Backend.** Does a thing.' }];
  assert.equal(await pushChangelog({ send, enabled: true, entries: list }), 1);
  assert.equal(sent[0].title, 'Shipped: X');
  assert.equal(sent[0].body, 'Backend. Does a thing.');
  assert.equal(await pushChangelog({ send, enabled: true, entries: list }), 0);
});
