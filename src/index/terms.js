// AI words, explained: a glossary of the jargon in AI news with how much of
// the coverage uses each term month by month. A term's share is the
// headlines that use it out of all stored headlines that month, so a busier
// crawl doesn't read as a rising word. Growth compares the last 90 days'
// share with the 90 before. Words that also mean other things (agents, memory, tokens)
// only count next to an AI word.

import { splitOutlet } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
const AI = 'title:(AI OR LLM OR LLMs OR chatbot OR chatbots OR ChatGPT OR Claude OR Gemini OR GPT OR OpenAI OR Anthropic OR model OR models OR Copilot OR Grok)';

// [key, term, kind, FTS, needs an AI word, definition]
export const TERMS = [
  ['agents', 'AI agents', 'Products', '"AI agent" OR "AI agents" OR agentic', false, 'AI systems that carry out multi-step tasks on their own, using tools such as a browser, code or other apps, instead of only answering a question.'],
  ['vibe-coding', 'Vibe coding', 'Culture', '"vibe coding" OR "vibe coded" OR "vibe coder" OR "vibe coders" OR "vibe-code"', false, 'Building software by describing what you want to an AI and accepting the code it writes, often without reading it closely.'],
  ['computer-use', 'Computer use', 'Products', '"computer use" OR "computer-use" OR "browser agent" OR "browser agents"', false, 'An AI model operating a computer the way a person does: looking at the screen, moving the mouse, clicking and typing.'],
  ['deep-research', 'Deep research', 'Products', '"deep research"', false, 'An assistant mode that searches and reads many sources over minutes, then writes a cited report.'],
  ['mcp', 'MCP', 'Techniques', '"Model Context Protocol" OR MCP', true, 'The Model Context Protocol, an open standard for connecting AI assistants to tools and data sources through a common interface.'],
  ['reasoning', 'Reasoning models', 'Techniques', '"reasoning model" OR "reasoning models" OR "thinking model" OR "thinking models"', false, 'Models trained to work through a problem step by step before answering, spending more computation on harder questions.'],
  ['cot', 'Chain of thought', 'Techniques', '"chain of thought" OR "chain-of-thought"', false, 'The written-out intermediate steps a model produces on the way to an answer; also a way of prompting for them.'],
  ['test-time', 'Test-time compute', 'Techniques', '"test-time compute" OR "inference-time compute" OR "test-time scaling" OR "inference scaling"', false, 'Getting better answers by letting a model think longer when it is used, rather than only by training a bigger model.'],
  ['moe', 'Mixture of experts', 'Techniques', '"mixture of experts" OR "mixture-of-experts" OR MoE', true, 'A model split into many expert sub-networks with only a few active for each token, so it can be very large but cheap to run.'],
  ['rag', 'RAG', 'Techniques', '"retrieval-augmented" OR "retrieval augmented" OR RAG', true, 'Retrieval-augmented generation: looking up relevant documents first and giving them to the model, so answers rest on sources.'],
  ['fine-tuning', 'Fine-tuning', 'Techniques', '"fine-tuning" OR "fine-tune" OR "fine-tuned" OR finetuning', false, 'Training an existing model further on a smaller, specific dataset to adapt it to a task, domain or style.'],
  ['distillation', 'Distillation', 'Techniques', 'distillation OR distill OR distilled OR distilling', true, 'Training a smaller model to imitate a larger one’s outputs; cheap to run, and at the centre of disputes over copying rivals’ models.'],
  ['rl', 'Reinforcement learning', 'Techniques', '"reinforcement learning" OR RLHF OR RLVR', false, 'Training by reward: the model tries, gets scored, and is pushed toward what scored well. RLHF uses human ratings as the reward.'],
  ['world-models', 'World models', 'Techniques', '"world model" OR "world models"', false, 'Models that learn how an environment behaves so they can simulate it: predicting what happens next in video, games or the physical world.'],
  ['multimodal', 'Multimodal', 'Techniques', 'multimodal OR "omni model" OR "omni-modal"', false, 'Handling more than one kind of input or output, such as text, images, audio and video, in one model.'],
  ['context-window', 'Context window', 'Techniques', '"context window" OR "context windows" OR "long context" OR "long-context" OR "million-token" OR "1M-token"', false, 'How much text a model can take in at once, measured in tokens; a million-token window fits several books.'],
  ['tokens', 'Tokens', 'Techniques', 'token OR tokens', true, 'The chunks of text a model reads and writes, about three quarters of a word each; usage and prices are counted in them.'],
  ['embeddings', 'Embeddings', 'Techniques', 'embedding OR embeddings', true, 'Lists of numbers that place text, images or audio by meaning, so similar things sit close together; the basis of semantic search.'],
  ['diffusion', 'Diffusion models', 'Techniques', '"diffusion model" OR "diffusion models" OR "text diffusion" OR "diffusion language"', false, 'Models that create images, video or even text by starting from noise and refining it step by step.'],
  ['transformer', 'Transformer', 'Techniques', 'transformer OR transformers', true, 'The neural network design behind nearly all of today’s language models, built around attention between every pair of tokens.'],
  ['slm', 'Small language models', 'Techniques', '"small language model" OR "small language models" OR "small model" OR "small models" OR SLM OR SLMs', false, 'Compact models, often a few billion parameters, that can run on a phone or laptop.'],
  ['quantization', 'Quantization', 'Techniques', 'quantization OR quantized OR "4-bit" OR FP4 OR FP8', true, 'Storing a model’s numbers at lower precision to make it smaller and faster, at some cost in quality.'],
  ['synthetic-data', 'Synthetic data', 'Techniques', '"synthetic data"', false, 'Training data produced by AI models rather than collected from people, used when real data runs short.'],
  ['open-weights', 'Open weights', 'Business', '"open weights" OR "open-weight" OR "open-weights" OR "open weight"', false, 'A model whose trained parameters are published for anyone to download and run, even if its training data and code are not.'],
  ['frontier', 'Frontier models', 'Business', '"frontier model" OR "frontier models" OR "frontier AI" OR "frontier lab" OR "frontier labs"', false, 'The most capable models at any time, and the handful of labs that build them.'],
  ['foundation', 'Foundation models', 'Business', '"foundation model" OR "foundation models"', false, 'Large general models trained on broad data that other products and models are built on.'],
  ['inference', 'Inference', 'Business', 'inference', true, 'Running a trained model to get answers, as opposed to training it; most of the AI chip demand is shifting here.'],
  ['compute', 'Compute', 'Business', 'compute', true, 'Shorthand for the computing power, chips and data centers used to train and run models.'],
  ['scaling', 'Scaling laws', 'Business', '"scaling law" OR "scaling laws" OR "scaling wall" OR "hit a wall"', false, 'The observed pattern that models improve predictably with more data, parameters and computation, and the debate over whether it continues.'],
  ['sovereign', 'Sovereign AI', 'Business', '"sovereign AI" OR "AI sovereignty"', false, 'Countries building their own models, data centers and chips so they don’t depend on foreign AI companies.'],
  ['physical-ai', 'Physical AI', 'Business', '"physical AI" OR "embodied AI"', false, 'AI that acts in the physical world through robots, vehicles and machines, rather than on a screen.'],
  ['ai-washing', 'AI washing', 'Business', '"AI washing" OR "AI-washing" OR "AIwashing"', false, 'Claiming a product or decision is driven by AI when it barely is, from marketing to blaming layoffs on AI.'],
  ['bubble', 'AI bubble', 'Business', '"AI bubble" OR "bubble"', true, 'The argument that AI valuations and data center spending have run far ahead of the revenue to justify them.'],
  ['agi', 'AGI', 'Safety', 'AGI OR "artificial general intelligence"', false, 'Artificial general intelligence: AI that can do most intellectual work as well as people. There is no agreed test for it.'],
  ['superintelligence', 'Superintelligence', 'Safety', 'superintelligence OR superintelligent OR ASI', false, 'AI far smarter than people at nearly everything; several labs now name it as their goal.'],
  ['alignment', 'Alignment', 'Safety', 'alignment OR misaligned OR misalignment', true, 'Making AI systems pursue what their makers and users intend, and not something else.'],
  ['jailbreak', 'Jailbreaks', 'Safety', 'jailbreak OR jailbreaks OR jailbroken OR jailbreaking', false, 'Prompts that trick a model into ignoring its safety rules.'],
  ['prompt-injection', 'Prompt injection', 'Safety', '"prompt injection" OR "prompt injections" OR "prompt-injection"', false, 'Hidden instructions planted in a web page, email or file that take over an AI agent reading it.'],
  ['red-teaming', 'Red teaming', 'Safety', '"red team" OR "red teaming" OR "red-teaming" OR "red teamers"', false, 'Deliberately attacking a model before release to find what harm it can be made to do.'],
  ['guardrails', 'Guardrails', 'Safety', 'guardrail OR guardrails OR safeguards', true, 'The filters, rules and training that stop a model from producing harmful or off-limits output.'],
  ['hallucination', 'Hallucinations', 'Safety', 'hallucination OR hallucinations OR hallucinate OR hallucinates OR hallucinating', false, 'When a model states something false with confidence, such as a made-up fact, quote or court case.'],
  ['sycophancy', 'Sycophancy', 'Safety', 'sycophancy OR sycophantic', false, 'A model telling users what they want to hear: flattering them or agreeing even when they are wrong.'],
  ['scheming', 'Scheming', 'Safety', 'scheming OR "reward hacking" OR sandbagging OR "deceptive alignment"', false, 'A model pursuing a hidden goal or gaming its tests, such as hiding what it can do or cheating on a task, seen so far in lab experiments.'],
  ['deepfake', 'Deepfakes', 'Culture', 'deepfake OR deepfakes', false, 'Realistic fake images, video or audio of real people made with AI.'],
  ['slop', 'AI slop', 'Culture', 'slop', false, 'Low-effort AI-generated content filling feeds, search results, shops and open-source inboxes.'],
  ['ai-psychosis', 'AI psychosis', 'Culture', '"AI psychosis" OR "chatbot psychosis" OR "AI-induced psychosis"', false, 'Delusions that seem to be fed or deepened by long conversations with a chatbot; an informal term, not a diagnosis.'],
  ['companions', 'AI companions', 'Culture', '"AI companion" OR "AI companions" OR "AI girlfriend" OR "AI boyfriend" OR "AI friend"', false, 'Chatbots built for friendship, romance or emotional support.'],
  ['humanoid', 'Humanoid robots', 'Business', 'humanoid OR humanoids', false, 'Robots with a human-like body, built to work in spaces made for people.'],
];
export const KINDS = ['Products', 'Techniques', 'Business', 'Safety', 'Culture'];

// The FTS index stems words ("transformer" also finds "transform") and
// ignores case ("MoE" also finds "Moe"), so each match is checked against
// the term's own words: acronyms case-sensitively, the rest not.
export function termMatcher(fts) {
  const parts = fts.split(/\s+OR\s+/).map((p) => p.replace(/^"|"$/g, ''));
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
  const acro = parts.filter((p) => /^(?:[A-Z0-9]{2,}s?|MoE|SLMs?)$/.test(p));
  const words = parts.filter((p) => !acro.includes(p));
  const ci = words.length ? new RegExp(`(?<![\\w-])(?:${words.map(esc).join('|')})(?![\\w-])`, 'i') : null;
  const cs = acro.length ? new RegExp(`(?<![\\w-])(?:${acro.map(esc).join('|')})(?![\\w-])`) : null;
  return (t) => !!(ci?.test(t) || cs?.test(t));
}
const AI_WORD = /\bAI\b|\bLLMs?\b|\bchatbots?\b|\bChatGPT\b|\bClaude\b|\bGemini\b|\bGPT\b|\bOpenAI\b|\bAnthropic\b|\bmodels?\b|\bCopilot\b|\bGrok\b/i;
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

export function computeTerms(db, now = Date.now()) {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() - 11);
  const since = Math.min(start.getTime(), now - 180 * DAY);
  const months = [];
  for (let d = new Date(start); d.getTime() <= now; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(monthOf(d.getTime()));
  const mi = new Map(months.map((m, i) => [m, i]));
  const types = "type IN ('article', 'post') AND hidden = 0";
  // Headlines stored each month and in each 90-day window, to turn counts into shares.
  const totals = new Map(db.prepare(`SELECT strftime('%Y-%m', published_at / 1000, 'unixepoch') AS m, COUNT(*) AS n FROM docs INDEXED BY docs_pub WHERE published_at >= ? AND published_at <= ? AND ${types} GROUP BY m`).all(start.getTime(), now + 5 * 60e3).map((r) => [r.m, r.n]));
  const win = db.prepare(`SELECT COUNT(*) AS n FROM docs INDEXED BY docs_pub WHERE published_at >= ? AND published_at < ? AND ${types}`);
  const all90 = win.get(now - 90 * DAY, now + 5 * 60e3).n;
  const allPrev = win.get(now - 180 * DAY, now - 90 * DAY).n;
  // One read per term; months, windows and examples come from the same rows.
  const rowsOf = db.prepare(`SELECT title, url, site, source, type, lang, published_at AS at FROM docs WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND published_at >= ? AND published_at <= ? AND ${types} ORDER BY published_at DESC`);

  const terms = TERMS.map(([key, term, kind, fts, needsAi, def]) => {
    const match = termMatcher(fts);
    const q = `title:(${fts})${needsAi ? ` AND ${AI}` : ''}`;
    const counts = months.map(() => 0);
    let n90 = 0;
    let nPrev = 0;
    const seen = new Set();
    const examples = [];
    for (const r of rowsOf.all(q, since, now + 5 * 60e3)) {
      const { title, outlet } = splitOutlet(r.title);
      if (!match(title) || (needsAi && !AI_WORD.test(title))) continue;
      const i = mi.get(monthOf(r.at));
      if (i != null) counts[i]++;
      if (r.at >= now - 90 * DAY) n90++;
      else if (r.at >= now - 180 * DAY) nPrev++;
      if (examples.length < 5 && r.type === 'article' && !/^Paper page\b/.test(title) && (!r.lang || r.lang.startsWith('en')) && /^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) {
        const k = title.toLowerCase().slice(0, 50);
        if (!seen.has(k)) {
          seen.add(k);
          examples.push({ title, url: r.url, source: outlet || r.source || r.site, at: r.at });
        }
      }
    }
    const series = months.map((m, i) => ({ m, n: counts[i], share: totals.get(m) ? counts[i] / totals.get(m) : 0 }));
    const share90 = all90 ? n90 / all90 : 0;
    const sharePrev = allPrev ? nPrev / allPrev : 0;
    const peak = series.reduce((a, b) => (b.share > a.share ? b : a), series[0]);
    return {
      key,
      term,
      kind,
      def,
      series,
      n: counts.reduce((a, b) => a + b, 0),
      n90,
      share90,
      sharePrev,
      // Change in share; null while the term barely appeared before.
      growth: nPrev >= 5 && sharePrev ? share90 / sharePrev - 1 : null,
      peak: peak?.n ? peak.m : null,
      examples,
    };
  });
  const ranked = terms.filter((t) => t.growth != null && t.n90 >= 10);
  return {
    generatedAt: now,
    months,
    kinds: KINDS,
    terms,
    rising: [...ranked].sort((a, b) => b.growth - a.growth).slice(0, 6).map((t) => t.key),
    fading: [...ranked].sort((a, b) => a.growth - b.growth).filter((t) => t.growth < 0).slice(0, 4).map((t) => t.key),
    stats: { terms: terms.length, headlines90: all90, headlinesPrev: allPrev },
  };
}

export const termsQuery = () => cachedJob('terms', { kind: 'terms' }, TTL_MS);
