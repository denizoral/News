// HTTP plumbing shared by the public site and the admin API: client IP
// resolution, security headers, cookies, bounded JSON bodies, IP allowlists.

import net from 'node:net';

// ---- Client IP ----
// X-Forwarded-For is trivially spoofed, so it's only read when TRUST_PROXY
// says how many proxies (load balancer, CDN) sit in front of us. With N
// trusted hops, the client is the Nth address from the right.
const TRUST_HOPS = Math.max(0, Number(process.env.TRUST_PROXY) || 0);

export function clientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || '');
  if (!TRUST_HOPS) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => normalizeIp(s.trim())).filter(Boolean);
  const all = [...chain, socketIp];
  return all[Math.max(0, all.length - 1 - TRUST_HOPS)] || socketIp;
}

function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// ---- IP allowlist (exact addresses or IPv4/IPv6 CIDR) ----
export function parseAllowlist(spec = '') {
  const list = new net.BlockList();
  let count = 0;
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = entry.split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!type) throw new Error(`ADMIN_ALLOWED_IPS: "${entry}" isn't an IP address or CIDR range.`);
    if (bits != null) list.addSubnet(addr, Number(bits), type);
    else list.addAddress(addr, type);
    count++;
  }
  return count ? (ip) => net.isIP(ip) !== 0 && list.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4') : null;
}

// ---- Security headers ----
const PUBLIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'", // odds bars set width inline; no script runs from styles
  "font-src https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
].join('; ');

// The admin UI loads nothing from third parties at all.
const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(res, { admin = false } = {}) {
  res.setHeader('Content-Security-Policy', admin ? ADMIN_CSP : PUBLIC_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', admin ? 'no-referrer' : 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.HSTS !== 'off' && process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  if (admin) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
}

// ---- Cookies ----
export function parseCookies(req) {
  const out = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, path = '/', sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  return parts.join('; ');
}

// ---- Bodies ----
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function readJson(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) return reject(new HttpError(415, 'Send JSON with Content-Type: application/json.'));
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, 'Request body is too large.'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        // Reviver drops keys that could pollute prototypes downstream.
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v)));
      } catch {
        reject(new HttpError(400, "The request body isn't valid JSON."));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'The request was interrupted.')));
  });
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}
