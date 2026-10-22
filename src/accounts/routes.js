// Reader account API, used by the Android app (bearer tokens; no cookies).
//
//   GET  /api/account/config     what's switched on (Google sign-in, push)
//   POST /api/account/signup     { email, password, name } -> { token, user }
//   POST /api/account/login      { email, password }       -> { token, user }
//   POST /api/account/google     { idToken }               -> { token, user }
//   GET  /api/account            -> { user }
//   PUT  /api/account/prefs      { follows?, alerts? }     -> { prefs }
//   POST /api/account/password   { current, next }         -> { token }
//   POST /api/account/logout
//   POST /api/account/delete     { password }
//   POST /api/devices            { token, app: 'wire' }    (signed in or not)
//   POST /api/devices/remove     { token }

import { readJson, sendJson, HttpError, clientIp } from '../security/httpkit.js';
import { RateLimiter } from '../security/ratelimit.js';
import * as users from './users.js';
import { verifyGoogleIdToken, googleEnabled, googleClientIds } from './google.js';
import { registerDevice, unregisterDevice } from '../push/mobile.js';
import { fcmEnabled } from '../push/fcm.js';

const limiter = new RateLimiter({ capacity: 120, refillPerSec: 2 }); // per IP, all account calls
const deviceLimiter = new RateLimiter({ capacity: 20, refillPerSec: 20 / 3600 });

const ROUTES = [
  ['GET', '/api/account/config', () => ({ google: googleEnabled(), googleClientId: googleClientIds()[0] || null, push: fcmEnabled(), passwordMin: 12 })],
  ['POST', '/api/account/signup', async ({ req, body }) => out(await users.signup(req, body))],
  ['POST', '/api/account/login', async ({ req, body }) => out(await users.login(req, body))],
  ['POST', '/api/account/google', async ({ req, body }) => out(users.googleLogin(req, await verifyGoogleIdToken(body.idToken)))],
  ['GET', '/api/account', ({ req }) => ({ user: users.publicUser(users.requireUser(req).user) })],
  ['PUT', '/api/account/prefs', ({ req, body }) => ({ prefs: users.savePrefs(users.requireUser(req), body) })],
  ['POST', '/api/account/password', async ({ req, body }) => ({ token: await users.changePassword(req, users.requireUser(req), body) })],
  ['POST', '/api/account/logout', ({ req }) => {
    const a = users.authenticate(req);
    if (a) users.logout(a);
    return { ok: true };
  }],
  ['POST', '/api/account/delete', async ({ req, body }) => {
    await users.deleteAccount(users.requireUser(req), body);
    return { ok: true };
  }],
  ['POST', '/api/devices', ({ req, body }) => {
    const lim = deviceLimiter.take(`ip:${clientIp(req)}`);
    if (!lim.ok) throw new HttpError(429, 'Too many devices from this network.', { retryAfter: lim.retryAfter });
    const a = users.authenticate(req);
    registerDevice({ token: body.token, app: 'wire', userId: a?.user.id ?? null, platform: body.platform });
    return { ok: true, push: fcmEnabled() };
  }],
  ['POST', '/api/devices/remove', ({ body }) => ({ ok: unregisterDevice(body.token) })],
];

const out = ({ user, token }) => ({ token, user: users.publicUser(user) });

export const isAccountPath = (p) => p === '/api/account' || p.startsWith('/api/account/') || p === '/api/devices' || p.startsWith('/api/devices/');

export async function accountRoute(req, res, url) {
  try {
    const lim = limiter.take(`ip:${clientIp(req)}`);
    if (!lim.ok) throw new HttpError(429, 'Too many requests. Slow down.', { retryAfter: lim.retryAfter });
    const r = ROUTES.find(([m, p]) => p === url.pathname && m === req.method);
    if (!r) throw new HttpError(ROUTES.some(([, p]) => p === url.pathname) ? 405 : 404, 'Not found.');
    // Browsers can't send these from another site without a preflight we
    // never answer: JSON bodies only.
    if (req.method !== 'GET' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'Send JSON.');
    const body = req.method === 'GET' ? {} : (await readJson(req, { limit: 32 * 1024 })) || {};
    const data = await r[2]({ req, res, url, body });
    return sendJson(res, 200, data, { 'cache-control': 'no-store' });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, fields: err.extra?.fields }, err.extra?.retryAfter ? { 'retry-after': String(err.extra.retryAfter) } : {});
    console.error('[account]', err);
    return sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
}
