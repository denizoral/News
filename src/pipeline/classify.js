// Relevance, topics and named entities. Entities power both the topic chips and
// the Polymarket matcher, so every alias resolves to one canonical key.

export const ENTITIES = {
  openai: ['openai', 'chatgpt', 'sam altman', 'altman', 'sora', 'codex', 'gpt'],
  anthropic: ['anthropic', 'claude', 'dario amodei', 'amodei'],
  google: ['google', 'deepmind', 'gemini', 'demis hassabis', 'hassabis', 'bard', 'gemma', 'veo', 'alphabet'],
  meta: ['meta ai', 'meta', 'llama', 'zuckerberg', 'superintelligence labs'],
  xai: ['xai', 'x.ai', 'grok', 'spacexai', 'colossus'],
  musk: ['elon musk', 'musk'],
  microsoft: ['microsoft', 'copilot', 'satya nadella', 'nadella'],
  apple: ['apple', 'siri', 'apple intelligence', 'tim cook'],
  amazon: ['amazon', 'aws', 'alexa', 'bedrock'],
  nvidia: ['nvidia', 'jensen huang', 'blackwell', 'rubin', 'cuda'],
  amd: ['amd', 'lisa su', 'instinct'],
  tsmc: ['tsmc'],
  deepseek: ['deepseek'],
  qwen: ['qwen', 'alibaba'],
  mistral: ['mistral'],
  perplexity: ['perplexity'],
  huggingface: ['hugging face', 'huggingface'],
  cursor: ['cursor', 'anysphere'],
  ssi: ['safe superintelligence', 'ilya sutskever', 'sutskever'],
  tesla: ['tesla', 'optimus', 'robotaxi', 'fsd'],
  figure: ['figure ai', 'humanoid'],
  china: ['china', 'chinese', 'beijing', 'huawei', 'moonshot', 'kimi', 'minimax', 'zhipu', 'bytedance'],
  agi: ['agi', 'superintelligence', 'asi'],
  ipo: ['ipo', 'goes public', 'public listing', 'market cap'],
  regulation: ['regulation', 'regulator', 'ai act', 'executive order', 'senate', 'congress', 'ftc', 'doj', 'antitrust', 'lawsuit', 'sues', 'court', 'ban'],
  funding: ['raises', 'funding', 'valuation', 'series a', 'series b', 'series c', 'investment', 'invests', 'acquire', 'acquires', 'acquisition', 'billion'],
  benchmark: ['benchmark', 'lmarena', 'arena', 'leaderboard', 'swe-bench', 'arc-agi', 'humanity\'s last exam', 'elo'],
};

// Some aliases are too ambiguous to stand alone. Require word boundaries for all,
// and treat these as weak (they need a second AI signal to count).
const WEAK = new Set(['meta', 'apple', 'amazon', 'google', 'microsoft', 'musk', 'elon musk', 'tesla', 'china', 'chinese', 'ban', 'court', 'billion', 'arena', 'elo', 'cursor', 'asi', 'beijing', 'gpt']);

const escapeRe = (a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasKey = new Map(Object.entries(ENTITIES).flatMap(([key, aliases]) => aliases.map((a) => [a, key])));

// One pass over the text instead of one regex per alias (~140): a single
// alternation, longest alias first, matched at word boundaries. The scan
// restarts one character after each match so overlapping aliases are still
// found ("meta ai act" yields both meta and regulation), and an alias that
// starts with a shorter one also credits the shorter ("meta ai" -> "meta").
const ALIAS_RE = new RegExp(`(?<![a-z0-9])(?:${[...aliasKey.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![a-z0-9])`, 'g');
const prefixAliases = new Map([...aliasKey.keys()].map((a) => [a, [...aliasKey.keys()].filter((b) => b !== a && a.startsWith(b) && !/[a-z0-9]/.test(a[b.length]))]));

const AI_TERMS = /\b(ai|a\.i\.|artificial intelligence|machine learning|deep learning|llms?|large language models?|neural|chatbots?|generative|genai|gpt-?\d|transformer|agents?|agentic|inference|foundation models?|frontier models?|reasoning models?|multimodal|diffusion|fine-?tun\w*|embeddings?|rag|openai|anthropic|claude|gemini|deepmind|llama|mistral|grok|copilot|chatgpt|hugging ?face|nvidia|gpus?|datacenters?|data centers?|superintelligence|agi|vibe ?cod\w*|mcp|tokens?|weights|open-?source models?|robotics|humanoids?)\b/i;

export function isAiRelated(text) {
  return AI_TERMS.test(text);
}

// How many AI-term mentions a text has, counting up to `cap`.
const AI_TERMS_GLOBAL = new RegExp(AI_TERMS.source, 'gi');
export function countAiTerms(text, cap = 10) {
  let n = 0;
  AI_TERMS_GLOBAL.lastIndex = 0;
  while (n < cap && AI_TERMS_GLOBAL.exec(text)) n++;
  return n;
}

export function extractEntities(text) {
  const t = text.toLowerCase();
  const found = new Map();
  const credit = (alias) => {
    const key = aliasKey.get(alias);
    found.set(key, found.get(key) || !WEAK.has(alias));
  };
  ALIAS_RE.lastIndex = 0;
  for (let m; (m = ALIAS_RE.exec(t)); ) {
    credit(m[0]);
    for (const p of prefixAliases.get(m[0])) credit(p);
    ALIAS_RE.lastIndex = m.index + 1;
  }
  // Same key order as ENTITIES, so callers see a stable order.
  return new Map(Object.keys(ENTITIES).filter((k) => found.has(k)).map((k) => [k, found.get(k)])); // key -> strong?
}

const TOPIC_RULES = [
  ['Models', /\b(gpt-?\d|claude|gemini|llama|grok|qwen|mistral|deepseek|model|weights|checkpoint|release[sd]?|launch(es|ed)?|introduc\w+|o\d-|reasoning|multimodal|open-?weight)\b/i],
  ['Research', /\b(paper|arxiv|research|study|researchers|benchmark|interpretability|alignment|scaling|dataset|training run|evals?)\b/i],
  ['Policy', /\b(regulat\w*|policy|law|lawsuit|court|senate|congress|eu|ai act|executive order|ban|copyright|safety institute|government|ftc|antitrust|election)\b/i],
  ['Money', /\b(rais(es|ed)|funding|valuation|ipo|acquir\w+|acquisition|invest\w*|revenue|earnings|stock|shares|billion|deal|market cap)\b/i],
  ['Chips', /\b(nvidia|gpu|chips?|semiconductor|tsmc|amd|tpu|datacenter|data center|compute|blackwell|rubin|power grid|gigawatt)\b/i],
  ['Products', /\b(app|feature|rolls? out|available|launch\w*|users|pricing|subscription|plus|pro|api|update|browser|assistant|voice|agent)\b/i],
  ['Open source', /\b(open-?source|open-?weight|hugging ?face|github|apache|mit license|gguf|local|ollama|llama\.cpp)\b/i],
  ['Robotics', /\b(robot\w*|humanoid|optimus|figure|self-driving|autonomous|waymo)\b/i],
];

export function topicsFor(text) {
  const out = [];
  for (const [name, re] of TOPIC_RULES) if (re.test(text)) out.push(name);
  return out.slice(0, 3);
}

// "Built with AI" detection for community posts.
const BUILD_TERMS = /\b(i (built|made|created|shipped|launched|wrote|vibe[- ]?coded)|we (built|made|launched|shipped)|show hn|my (first )?(app|project|tool|side project)|introducing my|weekend project|open[- ]sourced? my|side project|built (this|a|an) |made (this|a|an) |vibe[- ]?cod\w*|launch(ed|ing) (my|our))\b/i;

export function looksLikeBuild(text) {
  return BUILD_TERMS.test(text);
}
