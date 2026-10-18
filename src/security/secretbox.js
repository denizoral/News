// Encryption at rest for small secrets (TOTP seeds) with AES-256-GCM.
//
// The key comes from ADMIN_ENCRYPTION_KEY (32 bytes, base64) when set, which is
// what production should use (from a secret manager, never the repo).
// Otherwise a key is generated once into <DATA_DIR>/admin.key with 0600
// permissions. data/ is git-ignored, so the key never reaches version control.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let key = null;

function loadKey() {
  if (key) return key;
  const fromEnv = process.env.ADMIN_ENCRYPTION_KEY;
  if (fromEnv) {
    const k = Buffer.from(fromEnv, 'base64');
    if (k.length !== 32) throw new Error('ADMIN_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
    return (key = k);
  }
  const file = path.resolve(process.env.DATA_DIR || 'data', 'admin.key');
  try {
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (k.length === 32) return (key = k);
  } catch { /* create below */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600, flag: 'wx' });
  return (key = k);
}

export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function open(sealed) {
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// Tests use an in-memory key.
export function _setKeyForTests(k) {
  key = k;
}
