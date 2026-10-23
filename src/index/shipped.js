// Shipped: a changelog for the AI products people use, from headlines.
// A headline counts when the product (ChatGPT, Claude, Gemini, Copilot…) or
// its maker is the subject and it ships something: "Claude can now build
// your dashboards", "OpenAI rolls out locked chats for ChatGPT", "Gemini app
// replacing Gems with skills". Each is read for what kind of change it is (a
// feature, a new model, pricing, availability, a removal, or a test spotted
// before launch); outlets reporting the same change within days are one
// entry. Weekly counts per product show who ships most.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
export const SHIPPED_DAYS = 120;
export const WEEKS = 17;

// [key, label, product pattern, maker pattern]
export const PRODUCTS = [
  ['claude-code', 'Claude Code', /\bClaude Code\b/, /\bAnthropic\b/],
  ['codex', 'Codex', /\bCodex\b/, /\bOpenAI\b/],
  ['chatgpt', 'ChatGPT', /\bChatGPT\b|\bSora app\b|\bChatGPT Atlas\b/, /\bOpenAI\b/],
  ['claude', 'Claude', /\bClaude\b/, /\bAnthropic\b/],
  ['gemini', 'Gemini', /\bGemini\b|\bNotebookLM\b|\bAI Mode\b|\bAI Overviews\b/, /\bGoogle\b|\bDeepMind\b/],
  ['copilot', 'Copilot', /\bCopilot\b/, /\bMicrosoft\b|\bGitHub\b/],
  ['grok', 'Grok', /\bGrok\b/, /\bxAI\b|\bSpaceXAI\b|\bX\b/],
  ['meta', 'Meta AI', /\bMeta AI\b|\bMuse\b/, /\bMeta\b/],
  ['perplexity', 'Perplexity', /\bPerplexity\b|\bComet\b/, /\bPerplexity\b/],
  ['cursor', 'Cursor', /\bCursor\b/, /\bAnysphere\b/],
  ['siri', 'Apple Intelligence', /\bApple Intelligence\b|\bSiri\b/, /\bApple\b/],
  ['alexa', 'Alexa+', /\bAlexa\b/, /\bAmazon\b/],
];
const LABEL = Object.fromEntries(PRODUCTS.map(([k, l]) => [k, l]));

const SHIP = /\b(?:can now|now (?:lets?|can|has|supports?|works|shows|offers|available|integrates)|adds?|added|adding|(?:is |are )?getting (?:a |an |new |its |\w+ing )|gets (?:a |an |new |its |support|access)|rolls? out|rolled out|rolling out|begun rolling out|launch(?:es|ed)?|introduc(?:es|ed|ing)|brings?|unveil(?:s|ed)?|ships?|shipped|expands?|arriv(?:es|ed)|(?:is |are )testing|tests (?:a |an |new )|spotted|upgrades?|replac(?:es|ing)|removes?|removing|kills?|retires?|drops (?:support|access|\w+ (?:from|for))|raises? (?:the )?price|lets you|will let|integrates)\b/i;
// Third parties building on a product, how-tos, comparisons and opinion.
const NOT = /^(?:I|I've|I'm|We|My|Our|Why|How|What|When|Is|Are|Does|Do|Can|Spooked)\b|\b(?:didn|doesn|don|isn|won)['’]t\b|…$|\.\.\.$|\bthe fix has shipped\b|\bflags\b|\bIPO\b|\btrademarks?\b|\bTMs\b|\bUSPTO\b|\bvaluation\b|\bcybercriminals?\b|\battacks?\b|\bhow to\b|\btips?\b|\bvs\.?\b|\bversus\b|\bcompared\b|\bbest\b|\bI (?:tried|tested|asked|used)\b|\bwe (?:tried|tested|asked)\b|\breview\b|\bhands-on\b|\bstocks?\b|\bshares\b|\blawsuit\b|\bsued?\b|\bhack\w*|\bbreach\w*|\bleak\w*|\boutage\w*|\bdown\b|\bon Amazon Bedrock\b|\bon AWS\b|\bfor ChatGPT, Claude\b|\bwith ChatGPT and Codex\b|\bPaper page\b|\?$/i;

export const KINDS = [
  ['removal', 'Removed or retired', /\bremov\w*|\bkills?\b|\bretir\w*|\bdrops?\b|\bends?\b|\bshut\w*|\bdiscontinu\w*|\bsunset\w*|\bno longer\b|\bgoes away\b|\breplac\w*|\bcuts? (?:\S+ ){0,3}(?:access|users|limits?|models?)\b|\blos(?:e|es|ing) access\b/i],
  ['pricing', 'Pricing and plans', /\bprice\w*|\bpricing\b|\bfree\b|\bplans?\b|\bsubscri\w*|\btiers?\b|\bcredits?\b|\b\$\d|\bpaid\b|\bPlus\b|\bPro\b|\bMax\b|\bUltra\b|\bads?\b|\blimits?\b/],
  ['test', 'Testing, spotted', /\btest(?:s|ing)?\b|\bspotted\b|\bin the works\b|\bcoming soon\b|\bpreview\b|\bbeta\b|\bexperiment\w*|\bearly access\b|\bwaitlist\b/i],
  ['model', 'New model', /\b(?:GPT|Opus|Sonnet|Haiku|Gemini|Grok|Llama|Muse|Codex)[- ]?\d[\w.-]*\b|\bnew model\b|\bmodel\b/i],
  ['reach', 'More places and people', /\bcountries\b|\bin (?:the )?(?:EU|UK|India|Japan|China|Europe)\b|\bmore users\b|\ball users\b|\beveryone\b|\bAndroid\b|\biOS\b|\biPhone\b|\bWindows\b|\bMac\b|\bdesktop\b|\bCarPlay\b|\bcars?\b|\bTVs?\b|\bglasses\b|\bworkspace\b|\bSlack\b|\bTeams\b|\bexpands?\b|\bavailable\b|\blanguages?\b/i],
  ['feature', 'New feature', /./],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));

// The product the headline is about: named or made by the subject, before the verb.
export function parseShip(rawTitle) {
  const { title } = splitOutlet(rawTitle.replace(/^\[[^\]]{1,30}\]\s*/, ''));
  if (NOT.test(title)) return null;
  const verb = SHIP.exec(title);
  if (!verb) return null;
  const head = title.slice(0, verb.index);
  let product = null;
  for (const [key, , re, maker] of PRODUCTS) {
    const named = re.exec(title);
    if (!named) continue;
    // "Claude can now…" or "Anthropic adds … to Claude": the headline
    // opens with the product or its maker.
    const lead = head.replace(/^(?:\w+['’]s\s+)?(?:new\s+)?/i, '');
    const opens = (re) => { const m = re.exec(lead); return m && m.index <= 12 && m.index < verb.index; };
    if (opens(re) || opens(maker)) {
      product = key;
      break;
    }
  }
  if (!product) return null;
  const kind = KINDS.find(([, , re]) => re.test(title))[0];
  return { title, product, kind };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function computeShipped(db, now = Date.now(), days = SHIPPED_DAYS) {
  const rows = db.prepare(`SELECT title, url, source, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(now - days * DAY, now + 5 * 60e3);
  const entries = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title || '');
    if (!title || title.length > 180 || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue;
    const p = parseShip(r.title);
    if (!p) continue;
    headlines++;
    const source = outlet || r.source || '';
    const toks = new Set(tokens(title));
    const same = entries.find((x) => x.product === p.product && r.at - x.last < 4 * DAY && overlap(toks, x.toks) >= 0.4);
    if (same) {
      same.last = r.at;
      same.outlets.add(source);
      for (const t of toks) same.toks.add(t);
      if (!same.reports.some((x) => overlap(toks, new Set(tokens(x.title))) >= 0.8)) same.reports.push({ title, url: r.url, source, at: r.at });
      continue;
    }
    entries.push({ ...p, at: r.at, last: r.at, url: r.url, source, toks, outlets: new Set([source]), reports: [{ title, url: r.url, source, at: r.at }] });
  }

  const out = entries.map((x) => ({
    id: `${x.product}-${new Date(x.at).toISOString().slice(0, 10)}-${[...x.toks].slice(0, 3).join('-')}`.replace(/[^a-z0-9-]/gi, '').slice(0, 70),
    at: x.at,
    product: x.product,
    kind: x.kind,
    title: x.title,
    url: x.url,
    source: x.source,
    outlets: x.outlets.size,
    reports: x.reports.slice(0, 6),
  })).sort((a, b) => b.at - a.at);

  // Weeks end at now; the last column is the last seven days.
  const weekStart = now - WEEKS * 7 * DAY;
  const grid = PRODUCTS.map(([key, label]) => {
    const weeks = new Array(WEEKS).fill(0);
    for (const x of out) if (x.product === key && x.at >= weekStart) weeks[Math.min(WEEKS - 1, Math.floor((x.at - weekStart) / (7 * DAY)))]++;
    const list = out.filter((x) => x.product === key);
    return {
      key,
      label,
      n: list.length,
      n30: list.filter((x) => x.at >= now - 30 * DAY).length,
      last: list[0]?.at || null,
      kinds: Object.fromEntries(KINDS.map(([k]) => [k, list.filter((x) => x.kind === k).length])),
      weeks,
    };
  }).filter((p) => p.n).sort((a, b) => b.n30 - a.n30 || b.n - a.n);
  const week = out.filter((x) => x.at >= now - 7 * DAY);
  return {
    generatedAt: now,
    days,
    weekStart,
    headlines,
    entries: out.slice(0, 600),
    products: grid,
    kinds: KINDS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.kind === key).length })),
    labels: { products: LABEL, kinds: KIND_LABEL },
    stats: {
      entries: out.length,
      week: week.length,
      products: grid.length,
      busiest: grid[0] ? { label: grid[0].label, n30: grid[0].n30 } : null,
      removals30: out.filter((x) => x.kind === 'removal' && x.at >= now - 30 * DAY).length,
    },
  };
}

export const shippedQuery = () => cachedJob('shipped', { kind: 'shipped' }, TTL_MS);
