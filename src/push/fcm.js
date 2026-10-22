// Firebase Cloud Messaging (HTTP v1) for the Android apps.
//
// Needs the Firebase project's service account key at
// data/firebase-service-account.json (or FIREBASE_SERVICE_ACCOUNT=<path>),
// mode 600 and never in git. Without it, sending is off and the apps fall
// back to checking in the background. The key signs a short-lived OAuth token
// (JWT bearer grant); tokens are cached until five minutes before expiry.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const keyFile = () => process.env.FIREBASE_SERVICE_ACCOUNT || path.resolve(process.env.DATA_DIR || 'data', 'firebase-service-account.json');

let account = undefined; // undefined: not read yet; null: absent
let access = { token: null, exp: 0 };

export function fcmAccount() {
  if (account !== undefined) return account;
  try {
    const j = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
    account = j.client_email && j.private_key && j.project_id ? j : null;
  } catch {
    account = null;
  }
  return account;
}

export const fcmEnabled = () => !!fcmAccount();

export function resetFcm(acct) {
  account = acct;
  access = { token: null, exp: 0 };
}

async function accessToken(fetcher) {
  const now = Math.floor(Date.now() / 1000);
  if (access.token && access.exp - 300 > now) return access.token;
  const a = fcmAccount();
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: a.client_email, scope: SCOPE, aud: a.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), a.private_key).toString('base64url');
  const r = await fetcher(a.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Firebase token request answered ${r.status}`);
  const j = await r.json();
  access = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return access.token;
}

// Sends one notification. Returns 'ok', 'gone' (the app was uninstalled or
// the token rotated: forget it) or throws. Data values must be strings.
export async function sendFcm(token, { title, body, data = {}, channel = 'news', collapse }, { fetcher = fetch } = {}) {
  const a = fcmAccount();
  if (!a) throw new Error('Firebase isn’t set up');
  const message = {
    token,
    notification: { title: String(title).slice(0, 120), body: String(body).slice(0, 400) },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: channel === 'breaking' ? 'high' : 'normal', collapse_key: collapse, notification: { channel_id: channel, tag: collapse } },
  };
  const r = await fetcher(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(fetcher)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.ok) return 'ok';
  const err = await r.json().catch(() => ({}));
  const code = err.error?.details?.find((d) => d.errorCode)?.errorCode || err.error?.status;
  if (r.status === 404 || code === 'UNREGISTERED' || (r.status === 400 && code === 'INVALID_ARGUMENT' && /token/i.test(err.error?.message || ''))) return 'gone';
  throw new Error(`Firebase answered ${r.status}${code ? ` ${code}` : ''}`);
}
