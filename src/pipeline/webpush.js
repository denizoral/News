// Web Push with nothing but node:crypto: VAPID (RFC 8292) to identify the
// sender and aes128gcm payload encryption (RFC 8291 / RFC 8188).
//
// The server's VAPID key pair is made on first use and kept in
// data/vapid.json (never in git). Subscriptions only ever go to known push
// services over HTTPS, so a crafted "subscription" can't make the server
// send requests anywhere else.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';

const KEY_FILE = path.resolve(process.env.DATA_DIR || 'data', 'vapid.json');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// Hosts of the browsers' push services.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /^web\.push\.apple\.com$/];

export function validSubscription(sub) {
  try {
    const u = new URL(sub?.endpoint);
    if (u.protocol !== 'https:' || u.port || !PUSH_HOSTS.some((re) => re.test(u.hostname))) return false;
    if (sub.endpoint.length > 1000) return false;
    const p = unb64u(sub.keys?.p256dh || '');
    const a = unb64u(sub.keys?.auth || '');
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch {
    return false;
  }
}

let keys = null;
export function vapidKeys(file = KEY_FILE) {
  if (keys) return keys;
  try {
    keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subject: 'mailto:alerts@frontier-wire.invalid' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  }
  return keys;
}

// A P-256 private key object from the raw public and private parts.
function signingKey({ publicKey, privateKey }) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey }, format: 'jwk' });
}

// The Authorization header for one push service origin, valid 12 hours.
export function vapidAuth(endpoint, k = vapidKeys(), now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: k.subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), { key: signingKey(k), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${body}.${b64u(sig)}, k=${k.publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// Encrypts `plaintext` for a subscription as one aes128gcm record.
// `salt` and `serverKeys` are only passed by tests.
export function encrypt(sub, plaintext, { salt = crypto.randomBytes(16), serverKeys } = {}) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the text, then the 0x02 "last record" delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one message. Resolves to the push service's status; 404 and 410
// mean the subscription is gone.
export async function sendPush(sub, payload, { ttl = 6 * 3600, urgency = 'high', topic } = {}) {
  if (!validSubscription(sub)) throw new Error('Not a push service subscription.');
  const res = await request(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuth(sub.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency,
      ...(topic ? { topic: topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body: encrypt(sub, JSON.stringify(payload)),
    headersTimeout: 10e3,
    bodyTimeout: 10e3,
  });
  await res.body.dump();
  return res.statusCode;
}
