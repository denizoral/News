import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { termMatcher, computeTerms } from '../src/index/terms.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('AI words: matches are the words themselves, not stems or other cases', () => {
  const moe = termMatcher('"mixture of experts" OR "mixture-of-experts" OR MoE');
  assert.equal(moe('A 40B MoE coding model'), true);
  assert.equal(moe('A new mixture-of-experts design'), true);
  assert.equal(moe('NDP rejects claim from Scott Moe'), false);
  const tr = termMatcher('transformer OR transformers');
  assert.equal(tr('Diffusion transformers explained'), true);
  assert.equal(tr('Agents transform clinical work'), false);
});

test('AI words: shares by month, growth on the 90 days before, examples', () => {
  resetDb();
  let n = 0;
  const add = (title, daysAgo) => upsertDoc({ url: `https://x.com/${n++}`, type: 'article', title, description: '', body: '', site: 'example.com', source: 'Example', published_at: now - daysAgo * DAY });
  for (let i = 0; i < 12; i++) add(`Startup launches MCP server for AI agents ${i}`, 5 + i);
  for (let i = 0; i < 6; i++) add(`Company ships MCP connector for Claude ${i}`, 100 + i);
  for (let i = 0; i < 30; i++) add(`Weather report number ${i}`, 10 + i * 5);
  add('Scott Moe wins the vote', 3);
  const d = computeTerms(getDb(), now);
  const mcp = d.terms.find((t) => t.key === 'mcp');
  assert.equal(mcp.n90, 12);
  assert.equal(mcp.series.length, 12);
  assert.ok(mcp.series.at(-1).share > 0);
  assert.ok(mcp.growth != null);
  assert.equal(mcp.examples.length, 5);
  assert.equal(d.terms.find((t) => t.key === 'moe').n, 0, 'a name isn’t MoE');
});
