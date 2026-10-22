import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resetDb, q } from '../src/db.js';
import { velocity, BreakingTracker, breakingHistory, coverageCurve } from '../src/pipeline/breaking.js';
import { encrypt, validSubscription, vapidKeys, vapidAuth } from '../src/pipeline/webpush.js';
import { subscribe, pushBreaking, resetAlertPacing, subscriberCount } from '../src/pipeline/alerts.js';

const MIN = 60e3;
const now = Date.parse('2026-10-22T12:00:00Z');
const press = (source, minsAgo, title = `${source} on the news`) => ({ platform: 'web', kind: 'press', source, title, publishedAt: now - minsAgo * MIN });
const post = (handle, minsAgo) => ({ platform: 'x', kind: 'social', handle, source: handle, title: 'post', publishedAt: now - minsAgo * MIN });
const story = (sid, items, title = 'Big news') => ({ sid, title, url: `https://e.com/${sid}`, _group: items });

test('velocity: distinct voices in the hour, X capped, syndicated copies discounted', () => {
  const v = velocity([press('Reuters', 10), press('Reuters', 20), press('Verge', 30), post('a', 5), post('b', 5), post('c', 5), post('d', 5), post('e', 5), press('Old', 90)], now);
  assert.equal(v.press, 2);
  assert.equal(v.x, 5);
  assert.equal(v.weight, 2 + 4 * 0.75, 'only four X accounts count');
  const syn = velocity([press('A', 10, 'Same headline'), press('B', 9, 'Same headline'), press('C', 8, 'Same headline - C News')], now);
  assert.equal(syn.press, 1);
  assert.equal(syn.weight, 1.5);
});

test('breaking tracker: breaks once, holds while hot, cools off, and is recorded', () => {
  resetDb();
  const t = new BreakingTracker();
  const hot = story('hot0000001', [press('A', 40), press('B', 30), press('C', 20), press('D', 10)]);
  const slow = story('slow000001', [press('A', 300), press('B', 200), press('C', 100), press('D', 10)]);
  const old = story('old0000001', [press('X', 60 * 9), press('A', 40), press('B', 30), press('C', 20), press('D', 10)]); // first report 9h ago
  const started = t.update([hot, slow, old], now);
  assert.deepEqual(started.map((e) => e.sid), ['hot0000001']);
  assert.equal(t.update([hot, slow, old], now + MIN).length, 0, 'not again');
  assert.equal(t.active().length, 1);
  assert.ok(t.active()[0].curve.at(-1) >= 4);
  // Half an hour on it still has pace; nothing comes in after that.
  t.update([hot], now + 30 * MIN);
  t.update([hot], now + 55 * MIN);
  assert.equal(t.active().length, 1, 'still within the cool-off');
  t.update([hot], now + 65 * MIN);
  assert.equal(t.active().length, 0);
  const h = breakingHistory({ now: now + 2 * 3600e3 });
  assert.equal(h.length, 1);
  assert.ok(h[0].endedAt > h[0].startedAt);
  // A restart picks up a story that is still breaking.
  const t2 = new BreakingTracker();
  const b = story('hot0000002', [press('A', 40), press('B', 30), press('C', 20), press('D', 10)]);
  t2.update([b], now);
  const t3 = new BreakingTracker();
  t3.update([b], now + MIN);
  assert.equal(t3.active().length, 1);
});

test('coverage curve: distinct voices so far, every ten minutes', () => {
  assert.deepEqual(coverageCurve([press('A', 30), press('A', 25), press('B', 15), post('x', 5)], now - 30 * MIN, now), [1, 1, 2, 3]);
});

// The browser's side of RFC 8291, to check what we send decrypts.
function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const hk = (s, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from(info), n));
  const ikm = hk(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hk(salt, ikm, 'Content-Encoding: nonce\0', 12));
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt.at(-1), 2, 'last-record delimiter');
  return pt.subarray(0, -1).toString();
}

const browser = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
};

test('web push: payloads decrypt in the browser, VAPID tokens verify, only push services', () => {
  const b = browser();
  assert.equal(decrypt(encrypt(b.sub, '{"title":"Breaking"}'), b.ecdh, b.auth), '{"title":"Breaking"}');
  assert.ok(validSubscription(b.sub));
  assert.ok(!validSubscription({ ...b.sub, endpoint: 'https://127.0.0.1/push' }), 'not a push service');
  assert.ok(!validSubscription({ ...b.sub, endpoint: 'http://fcm.googleapis.com/x' }), 'https only');
  assert.ok(!validSubscription({ ...b.sub, keys: { ...b.sub.keys, auth: 'short' } }));

  const k = vapidKeys(path.join(os.tmpdir(), `vapid-${process.pid}.json`));
  const header = vapidAuth(b.sub.endpoint, k, now);
  const [, jwt, pub] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(pub, k.publicKey);
  const [h, body, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  const raw = Buffer.from(k.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('alerts: one push per break, gone subscriptions are dropped, paced', async () => {
  resetDb();
  resetAlertPacing();
  const a = browser(), gone = browser();
  gone.sub.endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/gone';
  assert.ok(subscribe(a.sub, now));
  assert.ok(subscribe(gone.sub, now));
  assert.ok(!subscribe({ endpoint: 'https://evil.example/x', keys: a.sub.keys }));
  const t = new BreakingTracker();
  const started = t.update([story('hot0000003', [press('A', 40), press('B', 30), press('C', 20), press('D', 10)], 'Lab ships model')], now);
  const sent = [];
  const send = async (sub, payload) => { sent.push([sub.endpoint, payload]); return sub.endpoint.includes('gone') ? 410 : 201; };
  assert.equal(await pushBreaking(started, t, { now, send }), 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0][1].body, 'Lab ships model');
  assert.equal(sent[0][1].url, '/#story/hot0000003');
  assert.equal(subscriberCount(), 1, 'the 410 subscription is gone');
  assert.equal(q('SELECT pushed FROM breaking WHERE sid = ?').get('hot0000003').pushed, 1);
  const next = t.update([story('hot0000004', [press('A', 40), press('B', 30), press('C', 20), press('D', 10)])], now + 5 * MIN);
  assert.equal(await pushBreaking(next, t, { now: now + 5 * MIN, send }), 0, 'within 20 minutes of the last');
});
