// Response encoding and the public snapshot shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Packed, pickEncoding } from '../src/server.js';
import { publicSnapshot } from '../src/store.js';
import { extractEntities } from '../src/pipeline/classify.js';

test('pickEncoding prefers Brotli, then gzip', () => {
  assert.equal(pickEncoding({ headers: { 'accept-encoding': 'gzip, deflate, br' } }), 'br');
  assert.equal(pickEncoding({ headers: { 'accept-encoding': 'gzip' } }), 'gzip');
  assert.equal(pickEncoding({ headers: {} }), null);
  assert.equal(pickEncoding({ headers: { 'accept-encoding': 'brotli-ish' } }), null);
});

test('Packed compresses once and round-trips', () => {
  const text = JSON.stringify({ a: 'x'.repeat(5000) });
  const p = new Packed(text, 5);
  const br = p.get('br');
  assert.equal(p.get('br'), br, 'kept after first use');
  assert.equal(zlib.brotliDecompressSync(br).toString(), text);
  assert.equal(zlib.gunzipSync(p.get('gzip')).toString(), text);
  assert.equal(p.get(null).toString(), text);
});

test('publicSnapshot drops server-only market fields and rounds volumes', () => {
  const snap = { version: 1, stories: [], markets: [{ id: 'pm:1', title: 'T', volume: 10.6, volume24h: 3.2, liquidity: 9, entities: ['openai'], outcomes: [{ label: 'Yes', yes: 0.4, change24h: 0.01, question: 'Q?', slug: 's', volume24h: 1, endDate: 'x' }] }] };
  const out = publicSnapshot(snap);
  assert.deepEqual(out.markets[0], { id: 'pm:1', title: 'T', entities: ['openai'], volume: 11, volume24h: 3, outcomes: [{ label: 'Yes', yes: 0.4, change24h: 0.01 }] });
  assert.equal(snap.markets[0].liquidity, 9, 'store copy untouched');
});

test('extractEntities finds overlapping and prefix aliases', () => {
  assert.deepEqual([...extractEntities('Meta AI act passes')], [['meta', true], ['regulation', true]]);
  assert.deepEqual([...extractEntities('Safe Superintelligence raises')], [['ssi', true], ['agi', true], ['funding', true]]);
  assert.deepEqual([...extractEntities('Apple stock')], [['apple', false]]);
  assert.deepEqual([...extractEntities('spacexai')], [['xai', true]]);
  assert.equal(extractEntities('pineapple metadata').size, 0);
});
