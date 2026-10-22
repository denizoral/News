// Verifies a Google ID token from the app's "Sign in with Google" (Android
// Credential Manager): RS256 signature against Google's published keys,
// issuer, audience (our OAuth client ids), expiry and a verified email.
// Off until GOOGLE_CLIENT_IDS is set (comma-separated: the web client id the
// app requests tokens for, plus any others).

import crypto from 'node:crypto';
import { HttpError } from '../security/httpkit.js';

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
let keys = { at: 0, ttl: 0, byKid: new Map() };

export const googleClientIds = () => (process.env.GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
export const googleEnabled = () => googleClientIds().length > 0;

async function keyFor(kid, fetcher = fetch) {
  const now = Date.now();
  if (!keys.byKid.has(kid) || now - keys.at > keys.ttl) {
    const r = await fetcher(CERTS, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new HttpError(503, 'Couldn’t reach Google to check the sign-in. Try again.');
    const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')?.[1]) || 3600;
    const { keys: list = [] } = await r.json();
    keys = { at: now, ttl: Math.min(maxAge, 86400) * 1000, byKid: new Map(list.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return keys.byKid.get(kid);
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export async function verifyGoogleIdToken(idToken, { audiences = googleClientIds(), now = Date.now(), fetcher } = {}) {
  if (!audiences.length) throw new HttpError(501, 'Google sign-in isn’t set up on this server yet.');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || idToken.length > 4096) throw new HttpError(400, 'That Google sign-in didn’t come through. Try again.');
  let header, claims;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    throw new HttpError(400, 'That Google sign-in didn’t come through. Try again.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'That Google sign-in isn’t valid.');
  const key = await keyFor(header.kid, fetcher);
  const ok = key && crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new HttpError(401, 'That Google sign-in isn’t valid.');
  const sec = now / 1000;
  if (!ISSUERS.has(claims.iss) || !audiences.includes(claims.aud) || !(claims.exp > sec - 60) || (claims.iat && claims.iat > sec + 300)) throw new HttpError(401, 'That Google sign-in has expired or isn’t for this app.');
  if (!claims.sub || !claims.email || claims.email_verified !== true && claims.email_verified !== 'true') throw new HttpError(401, 'Your Google account’s email isn’t verified.');
  return { sub: String(claims.sub), email: String(claims.email), name: claims.name || '' };
}

// For tests: forget cached keys.
export function resetGoogleKeys() {
  keys = { at: 0, ttl: 0, byKid: new Map() };
}
