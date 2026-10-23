import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { themesOf, nameOf, computePapers } from '../src/index/papers.js';
import { parseShip, computeShipped } from '../src/index/shipped.js';

const DAY = 86400e3;

test('papers: themes, names, rising words and papers in the news', () => {
  assert.deepEqual(themesOf('LatentLoop: Scaling Looped MoE Models with Asymmetric Compute'), ['efficiency']);
  assert.ok(themesOf('Agentic RL for Long-Horizon Web Navigation').includes('agents'));
  assert.equal(nameOf('Matrix-Game 4.0: Harnessing Video Models for Playable Worlds'), 'Matrix-Game 4.0');
  assert.equal(nameOf('Towards Better Reasoning: A Study'), null);
  resetDb();
  const now = Date.now();
  let n = 0;
  const add = (title, site, daysAgo, type = 'article') => upsertDoc({ url: `https://${site}/${n++}`, type, title, description: '', body: '', site, source: site, published_at: now - daysAgo * DAY });
  add('Paper page - QwenGyre: Elastic RL for Extreme-Long-Horizon Agents', 'huggingface.co', 5);
  add('Paper page - QwenGyre: Elastic RL for Extreme-Long-Horizon Agents', 'huggingface.co', 4);
  add('Paper page - Foresight: Planning with World Models', 'huggingface.co', 6);
  for (let i = 0; i < 10; i++) add(`Paper page - Looped Transformers Study ${i}`, 'huggingface.co', 3);
  add('Alibaba Qwen Introduces QwenGyre for long-horizon agents', 'marktechpost.com', 2);
  add('Google launched Foresight to search meeting notes', 'theverge.com', 2);
  const d = computePapers(getDb(), now);
  assert.equal(d.stats.papers, 12, 'one copy of each title');
  assert.deepEqual(d.inNews.map((p) => p.name), ['QwenGyre'], 'a plain name needs more than the name');
  assert.ok(d.rising.some((r) => r.w === 'looped'));
  assert.ok(d.themes.find((t) => t.key === 'agents').n >= 1);
});

test('shipped: the product or its maker ships something; others building on it don’t count', () => {
  assert.deepEqual(parseShip('ChatGPT now lets you lock your chats') && [parseShip('ChatGPT now lets you lock your chats').product], ['chatgpt']);
  assert.equal(parseShip('OpenAI rolls out PIN-protected locked chats for ChatGPT').product, 'chatgpt');
  assert.equal(parseShip('GitHub removes six Copilot models, including GPT-5.5').kind, 'removal');
  assert.equal(parseShip('Anthropic expands Claude Security into a continuous code monitor').product, 'claude');
  assert.equal(parseShip('Webflow Adds AI Skills to ChatGPT and Codex'), null);
  assert.equal(parseShip('I replaced my $20 ChatGPT subscription with local AI'), null);
  assert.equal(parseShip('ChatGPT didn’t kill Wikipedia. It took the homework.'), null);
  resetDb();
  const now = Date.now();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('ChatGPT now lets you lock your chats with a PIN', 'verge', 3);
  add('OpenAI now lets ChatGPT users lock chats with a PIN', 'tc', 2);
  add('Claude can now build your dashboards', 'zdnet', 10);
  add('Gemini app rolling out Gemini 4 Argon to AI Pro and AI Ultra', 'gtimes', 40);
  const d = computeShipped(getDb(), now);
  const chat = d.entries.filter((x) => x.product === 'chatgpt');
  assert.equal(chat.length, 1, 'one change across outlets');
  assert.equal(chat[0].outlets, 2);
  assert.equal(d.products.find((p) => p.key === 'claude').n30, 1);
  assert.equal(d.products[0].weeks.length, 17);
  assert.equal(d.stats.week, 1);
});
