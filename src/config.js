// Every source the crawler knows about. Add or remove entries here; nothing else
// needs to change. `weight` nudges ranking (1 = neutral) and `kind` drives the
// filter chips in the UI.

export const X_ACCOUNTS = [
  // Labs and companies: first-party announcements
  { handle: 'OpenAI', group: 'lab' },
  { handle: 'AnthropicAI', group: 'lab' },
  { handle: 'GoogleDeepMind', group: 'lab' },
  { handle: 'GoogleAI', group: 'lab' },
  { handle: 'AIatMeta', group: 'lab' },
  { handle: 'xai', group: 'lab' },
  { handle: 'MistralAI', group: 'lab' },
  { handle: 'deepseek_ai', group: 'lab' },
  { handle: 'Alibaba_Qwen', group: 'lab' },
  { handle: 'huggingface', group: 'lab' },
  { handle: 'perplexity_ai', group: 'lab' },
  { handle: 'NVIDIAAI', group: 'lab' },
  { handle: 'cursor_ai', group: 'lab' },
  { handle: 'claudeai', group: 'lab' },
  { handle: 'OpenAIDevs', group: 'lab' },
  { handle: 'GeminiApp', group: 'lab' },

  // Leaders whose posts are themselves the news
  { handle: 'sama', group: 'people' },
  { handle: 'gdb', group: 'people' },
  { handle: 'demishassabis', group: 'people' },
  { handle: 'DarioAmodei', group: 'people' },
  { handle: 'elonmusk', group: 'people', aiOnly: true },
  { handle: 'OfficialLoganK', group: 'people' },
  { handle: 'bcherny', group: 'people' },
  { handle: 'ClementDelangue', group: 'people' },

  // Researchers and practitioners: context and first reactions
  { handle: 'karpathy', group: 'people' },
  { handle: 'simonw', group: 'people' },
  { handle: 'emollick', group: 'people' },
  { handle: 'swyx', group: 'people' },
  { handle: 'DrJimFan', group: 'people' },
  { handle: 'AndrewYNg', group: 'people' },
  { handle: 'natolambert', group: 'people' },
  { handle: 'omarsar0', group: 'people' },
  { handle: '_akhaliq', group: 'people' },
  { handle: 'ArtificialAnlys', group: 'people' },
  { handle: 'lmarena_ai', group: 'people' },
  { handle: 'EpochAIResearch', group: 'people' },

  // Fast news and leak trackers: usually first to a story
  { handle: 'testingcatalog', group: 'scoops' },
  { handle: 'btibor91', group: 'scoops' },
  { handle: 'kimmonismus', group: 'scoops' },
  { handle: 'rowancheung', group: 'scoops' },
  { handle: 'TheRundownAI', group: 'scoops' },
  { handle: 'ai_for_success', group: 'scoops' },
  { handle: 'deedydas', group: 'scoops' },

  // Prediction markets: every post, not just AI ones. They break news early.
  { handle: 'Polymarket', group: 'scoops' },
  { handle: 'PolymarketIntel', group: 'scoops' },
  { handle: 'Kalshi', group: 'scoops' },
];

// Bluesky mirrors of AI voices. Only used while X is down (see crawler.js).
export const BLUESKY_ACCOUNTS = [
  'simonwillison.net',
  'karpathy.bsky.social',
  'emollick.bsky.social',
  'natolambert.bsky.social',
  'swyx.io',
  'huggingface.bsky.social',
  'theverge.com',
];

export const RSS_FEEDS = [
  // Labs
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml', kind: 'lab', weight: 1.6 },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', kind: 'lab', weight: 1.5 },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', kind: 'lab', weight: 1.3 },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', kind: 'lab', weight: 1.1 },
  { name: 'NVIDIA', url: 'https://blogs.nvidia.com/feed/', kind: 'lab', weight: 1.0, aiOnly: true },
  { name: 'AWS ML', url: 'https://aws.amazon.com/blogs/machine-learning/feed/', kind: 'lab', weight: 0.7 },

  // Press
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', kind: 'press', weight: 1.3 },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', kind: 'press', weight: 1.3 },
  { name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/', kind: 'press', weight: 1.2 },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', kind: 'press', weight: 1.2 },
  { name: 'Wired', url: 'https://www.wired.com/feed/tag/ai/latest/rss', kind: 'press', weight: 1.1 },
  { name: 'VentureBeat', url: 'https://venturebeat.com/category/ai/feed/', kind: 'press', weight: 1.0, topical: true },
  { name: 'The Decoder', url: 'https://the-decoder.com/feed/', kind: 'press', weight: 1.1 },
  { name: '404 Media', url: 'https://www.404media.co/rss/', kind: 'press', weight: 0.9, aiOnly: true },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', kind: 'press', weight: 0.7 },
  { name: 'Engadget', url: 'https://www.engadget.com/rss.xml', kind: 'press', weight: 0.9, aiOnly: true },
  { name: 'CNBC Tech', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910', site: 'cnbc.com', kind: 'press', weight: 1.0, aiOnly: true },

  // Newsletters and analysts
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', kind: 'analysis', weight: 1.1 },
  { name: 'Latent Space', url: 'https://www.latent.space/feed', kind: 'analysis', weight: 1.0 },
  { name: 'Import AI', url: 'https://jack-clark.net/feed/', kind: 'analysis', weight: 1.0 },
  { name: 'Interconnects', url: 'https://www.interconnects.ai/feed', kind: 'analysis', weight: 1.0 },
  { name: 'AI News (smol)', url: 'https://news.smol.ai/rss.xml', kind: 'analysis', weight: 1.0 },
  { name: 'TLDR AI', url: 'https://tldr.tech/api/rss/ai', kind: 'analysis', weight: 0.9 },
  { name: "Ben's Bites", url: 'https://www.bensbites.com/feed', kind: 'analysis', weight: 0.9 },
  { name: 'Lobsters', url: 'https://lobste.rs/t/ai.rss', kind: 'community', weight: 0.8 },
];

// Google News search is the widest net there is: it aggregates thousands of
// outlets and updates within minutes. One query per major subject.
export const GOOGLE_NEWS_QUERIES = [
  'OpenAI', 'Anthropic Claude', 'Google Gemini', 'xAI Grok', 'Meta AI Llama',
  'DeepSeek', 'Nvidia AI chips', 'Mistral AI', 'AI regulation', 'AI startup funding',
  'artificial intelligence model release', 'AGI',
];

// HTML pages without feeds. `link` matches article paths on the page.
export const SCRAPED_PAGES = [
  { name: 'Anthropic', url: 'https://www.anthropic.com/news', base: 'https://www.anthropic.com', link: /href="(\/news\/[a-z0-9-]+)"/g, kind: 'lab', weight: 1.6 },
  { name: 'Mistral AI', url: 'https://mistral.ai/news', base: 'https://mistral.ai', link: /href="(\/news\/[a-z0-9-]+)"/g, kind: 'lab', weight: 1.3 },
  { name: 'Meta AI', url: 'https://ai.meta.com/blog/', base: 'https://ai.meta.com', link: /href="(?:https:\/\/ai\.meta\.com)?(\/blog\/[a-z0-9-]+\/?)"/g, kind: 'lab', weight: 1.3 },
  { name: 'xAI', url: 'https://x.ai/news', base: 'https://x.ai', link: /href="(\/news\/[a-z0-9-]+)"/g, kind: 'lab', weight: 1.4 },
];

export const SUBREDDITS = {
  news: ['LocalLLaMA', 'singularity', 'OpenAI', 'ClaudeAI', 'MachineLearning', 'artificial', 'Bard', 'StableDiffusion', 'accelerate'],
  builds: ['SideProject', 'vibecoding', 'ClaudeAI', 'LocalLLaMA', 'ChatGPTCoding', 'cursor', 'AI_Agents', 'indiehackers'],
};

// Polymarket: AI tags plus targeted searches so we catch markets that are
// filed under business or tech rather than "AI".
export const POLYMARKET = {
  tags: ['ai', 'openai', 'tech'],
  searches: ['OpenAI', 'Anthropic', 'Gemini', 'Grok', 'xAI', 'Nvidia', 'DeepSeek', 'AGI', 'GPT', 'Claude', 'AI model', 'Sam Altman', 'Meta AI', 'Apple AI'],
  minVolume: 5000,
};

// Cadence per source, in seconds. Social and markets refresh fastest.
export const SCHEDULE = {
  x: 120,
  polymarket: 90,
  hackernews: 120,
  reddit: 180,
  bluesky: 180,
  googlenews: 300,
  rss: 300,
  scraped: 600,
  openrouter: 600,
  huggingface: 900,
  github: 1800,
  producthunt: 900,
  showhn: 300,
};

export const RETENTION_HOURS = 72;

// ---- Spider (focused web crawler) ----
// Hubs are section pages recrawled often to discover new articles. Their hosts
// are "trusted": the spider follows any link within them. Off-site links are
// followed only when their anchor text is about AI, and only one hop out.
export const SPIDER = {
  hubs: [
    'https://www.theverge.com/ai-artificial-intelligence',
    'https://techcrunch.com/category/artificial-intelligence/',
    'https://arstechnica.com/ai/',
    'https://venturebeat.com/category/ai/',
    'https://www.technologyreview.com/topic/artificial-intelligence/',
    'https://www.wired.com/tag/artificial-intelligence/',
    'https://the-decoder.com/',
    'https://www.404media.co/',
    'https://www.semafor.com/vertical/tech',
    'https://www.axios.com/technology',
    'https://www.cnbc.com/ai-artificial-intelligence/',
    'https://www.reuters.com/technology/artificial-intelligence/',
    'https://www.zdnet.com/topic/artificial-intelligence/',
    'https://www.engadget.com/ai/',
    'https://www.marktechpost.com/',
    'https://www.unite.ai/',
    'https://openai.com/news/',
    'https://www.anthropic.com/news',
    'https://deepmind.google/discover/blog/',
    'https://blog.google/technology/ai/',
    'https://ai.meta.com/blog/',
    'https://mistral.ai/news',
    'https://x.ai/news',
    'https://huggingface.co/blog',
    'https://blogs.nvidia.com/',
    'https://machinelearning.apple.com/',
    'https://www.microsoft.com/en-us/research/blog/',
    'https://simonwillison.net/',
    'https://www.latent.space/',
    'https://www.interconnects.ai/',
    'https://jack-clark.net/',
    'https://epoch.ai/blog',
  ],
  // Also crawl every article URL the aggregator finds (except these wrappers).
  skipHosts: ['news.google.com', 'x.com', 'twitter.com', 'bsky.app', 'reddit.com', 'news.ycombinator.com', 'youtube.com', 'youtu.be', 'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'polymarket.com', 'producthunt.com', 'github.com', 'huggingface.co/spaces', 'openrouter.ai'],
  concurrency: Number(process.env.SPIDER_CONCURRENCY) || 6,
  hostDelayMs: Number(process.env.SPIDER_HOST_DELAY_MS) || 2000,
  hostDailyBudget: Number(process.env.SPIDER_HOST_BUDGET) || 600,
  hubRecrawlMin: 15,
  sitemapRecrawlMin: 30,
  maxDepth: 3,
  maxPageBytes: 4 * 1024 * 1024,
  imageConcurrency: 3,
  // The lead image always; others only if they have alt text or a caption.
  imagesPerPage: 3,
};
