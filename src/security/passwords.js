// Password hashing with scrypt (memory-hard), self-describing format:
//   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
// so parameters can be raised later and old hashes still verify (and get
// rehashed on the next successful login).

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptRaw = promisify(crypto.scrypt);

// scrypt is deliberately expensive (~50-100 ms of CPU, 32 MB of memory), so an
// attacker spraying logins from many IPs could otherwise pin every core. Only a
// few hashes run at once; past a short queue, requests fail fast with 503.
const MAX_ACTIVE = Math.max(1, Number(process.env.ADMIN_HASH_CONCURRENCY) || 4);
const MAX_WAITING = 32;
let active = 0;
const waiting = [];

export class BusyError extends Error {
  constructor() {
    super('The sign-in service is busy. Try again in a moment.');
    this.status = 503;
  }
}

async function scrypt(...args) {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new BusyError();
    await new Promise((r) => waiting.push(r));
  }
  active++;
  try {
    return await scryptRaw(...args);
  } finally {
    active--;
    waiting.shift()?.();
  }
}
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false };
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: MAXMEM });
  const ok = got.length === expected.length && crypto.timingSafeEqual(got, expected);
  return { ok, needsRehash: ok && (+N < PARAMS.N || +r !== PARAMS.r || +p !== PARAMS.p) };
}

// Run a full hash anyway when the account doesn't exist, so response time
// doesn't reveal which usernames are real.
let dummy = null;
export async function burnTime(password) {
  dummy ||= await hashPassword('timing-equalizer-not-a-real-password');
  await verifyPassword(password || '', dummy);
}

const COMMON = new Set(['password', 'password1', 'password123', '123456789012', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'administrator', 'iloveyou', 'changeme', 'passw0rd', 'qwerty123', 'trustno1', 'frontierwire']);

// NIST 800-63B style: length over composition rules, plus a deny list.
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 256) return 'Use at most 256 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/\d+$/, ''))) return 'That password is too common. Choose another.';
  if (username && lower.includes(username.toLowerCase())) return "Don't include your username in the password.";
  if (/^(.+?)\1+$/.test(password)) return "Don't build the password by repeating something.";
  return null;
}

export function randomPassword() {
  // 20 chars from an unambiguous alphabet: about 115 bits.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
