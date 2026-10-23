import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseRelease, sizesOf, computeOpen } from '../src/index/openweights.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('open releases: lab, model, sizes, license, and what is not a release', () => {
  const a = parseRelease('StepFun Releases Step 5 Preview Open Weights: 600B MoE, 27B Active, 1M Context');
  assert.deepEqual([a.lab.key, a.lab.region, a.total, a.active, a.context], ['stepfun', 'china', 600, 27, 1e6]);
  const b = parseRelease('Liquid AI Releases Open-Weight LFM2.5-24B-A2B for On-Device Agents');
  assert.deepEqual([b.lab.key, b.name, b.modality], ['liquid', 'LFM2.5-24B-A2B', 'code']);
  assert.equal(parseRelease('Mistral AI Releases Leanstral 1.5: An Apache-2.0 Lean 4 Code Agent Model').license, 'apache');
  assert.equal(parseRelease('Moonshot AI Releases Kimi K3: A 2.8 Trillion Parameter Open MoE Model').total, 2800);
  // Built on another lab's weights: credited as a derivative.
  const c = parseRelease('Cognition Releases SWE-2: A Kimi K3 Post-Trained Coding Model');
  assert.deepEqual([c.lab.key, c.builder], ['moonshot', 'Cognition']);
  // Tools, deals, chips, hosted models and money aren't open releases.
  assert.equal(parseRelease('DeepSeek open-sources DeepInfer software for running its AI models'), null);
  assert.equal(parseRelease('NVIDIA Buys Hugging Face for $12.9B as Open-Source Robotics Scales Up'), null);
  assert.equal(parseRelease('Alibaba Launches Qwen-Image-3.0 Without Benchmarks or Weights'), null);
  assert.deepEqual(sizesOf('A $12.9B deal for a 30B model'), { total: 30, active: null });
});

test('open weights: one release across outlets, regions, sizes and derivatives', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Moonshot AI Releases Kimi K3: A 2.8 Trillion Parameter Open MoE Model', 'marktechpost', 10);
  add('Moonshot releases Kimi K3, an open-weight model to rival GPT', 'verge', 9);
  add('Nvidia Releases Open-Weight Nemotron 3 Ultra: 550B Agent Model', 'nvidia', 3);
  add('Cognition Releases SWE-2: A Kimi K3 Post-Trained Coding Model', 'cognition', 2);
  add('Google pauses open-source bug bounty over AI slop submissions', 'verge', 1);
  add('Alibaba Releases Qwen3.6-35B-A3B, an Open-Weight Coding Model', 'marktechpost', 20);
  const d = computeOpen(getDb(), now);
  const kimi = d.releases.filter((x) => x.lab.key === 'moonshot');
  assert.equal(kimi.length, 1, 'one release');
  assert.equal(kimi[0].outlets, 2);
  assert.equal(kimi[0].total, 2800);
  assert.equal(d.regions.find((r) => r.key === 'china').n, 2);
  assert.equal(d.stats.biggest.total, 2800);
  assert.equal(d.builtOn[0].key, 'moonshot');
  assert.equal(d.builtOn[0].builders[0].builder, 'Cognition');
  assert.equal(d.months.length, 12);
  const q = d.releases.find((x) => x.lab.key === 'qwen');
  assert.deepEqual([q.total, q.active], [35, 3], 'sizes from the name');
});
