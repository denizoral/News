// Open weights: the year's open model releases from headlines. A release
// headline names a lab, a verb (releases, launches, open-sources…), and
// either says the weights are open (open-weight, open-source model, Apache
// 2.0, on Hugging Face) or names a family that ships open (Gemma, Qwen,
// Llama, Nemotron, GLM…). From it come the model's name, its size (total
// and active parameters), the license, the context length and what it
// handles (text, code, images, speech, vision). Reports of the same lab's
// model within a month are one release; labs are placed in the US, China,
// Europe or elsewhere so the open-model race can be followed.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const OPEN_DAYS = 365;

const FAMILIES = 'Gemma|Qwen\\w*|Llama|Nemotron|gpt-oss|GLM|Kimi|DeepSeek|MiniMax|OLMo|Phi|Granite|Hunyuan|ERNIE|MiMo|Magistral|Devstral|Ministral|Mixtral|Voxtral|Codestral|Pixtral|Falcon|SmolLM|Muse|StepFun|Step|Inkling|Kolibri|Command|Aya|Jamba|Seed-OSS|EXAONE|Sarvam|Apertus|Bonsai';
const FTS = `title:("open-weight" OR "open weights" OR "open-weights" OR "open weight" OR "open-source" OR "open source" OR "open model" OR "open models" OR "Apache 2.0" OR "Hugging Face" OR Gemma OR Qwen OR Llama OR Nemotron OR "gpt-oss" OR GLM OR Kimi OR DeepSeek OR MiniMax OR OLMo OR Phi OR Granite OR Hunyuan OR Magistral OR Devstral OR Mistral OR StepFun OR EXAONE OR Falcon OR SmolLM) AND title:(releases OR released OR release OR launches OR launched OR unveils OR unveiled OR ships OR shipped OR "open-sources" OR "open-sourced" OR debuts OR drops OR dropped OR introduces OR introducing OR "rolls out" OR publishes OR announces)`;

const VERB = /\b(?:releases|released|launch(?:es|ed)?|unveil(?:s|ed)?|ships|shipped|open-sources?|open-sourced|open sources|debuts|introduc(?:es|ed|ing)|rolls? out|publish(?:es|ed)|announces|announced|is out|now available|goes open)\b/i;
// A model built on another lab's open weights.
const DERIVED = /\bpost-trained\b|\bbuilt on\b|\bpruned from\b|\bfine-tun\w*|\bbased on\b|\btrained on\b|\bdistill\w*|\bon top of\b/i;
const OPEN = /\bopen[- ]?weights?\b|\bopen[- ]source[ds]?\b|\bopen[- ]sourc(?:es|ing)\b|\bopen (?:\S+ )?models?\b|\bApache[- ]2\.0\b|\bMIT[- ]licen[sc]\w*|\bon Hugging Face\b|\bweights (?:are )?(?:out|available|released)\b|\bopen\b(?= (?:Nemotron|Gemma|Muse|\d))/i;
const FAMILY = new RegExp(`\\b(?:${FAMILIES})\\b`);
// Shipped open without saying so.
const OPEN_FAMILY = /\b(?:Gemma|Qwen\w*|Llama|Nemotron|gpt-oss|GLM|OLMo|Phi-\d|Granite|Hunyuan|MiMo|Devstral|Ministral|Mixtral|Voxtral|Falcon|SmolLM|Seed-OSS|EXAONE|Apertus|Kimi K\d|DeepSeek[- ](?:V|R)\d)\b/;
// A model, not a tool, engine, dataset or platform.
const MODEL = /\bmodels?\b|\bLLMs?\b|\bMoE\b|\bweights\b|\b\d+(?:\.\d+)?\s?[BT]\b|\bparameters?\b|\bcheckpoints?\b/i;
const NOT_MODEL = /\bframework\b|\bengine\b|\bplatform\b|\bsandbox\b|\btokenizer\b|\bharness\b|\bSDK\b|\blibrary\b|\bgateway\b|\bRun:ai\b|\bTorch\w*\b|\bPyTorch\b|\bserving\b|\binference (?:stack|framework|tech|engine)\b|\bdataset\b|\bbenchmark\b|\btool(?:kit|s)?\b|\bsecurity (?:scans?|issues|flaws)\b|\bCyber Mission\b|\bvulnerab\w*|\bbug bounty\b|\bsurvey\b|\bOpen Source For You\b|\bPaper page\b|\barXiv\b|\bhow (?:to|I)\b|\bwhy\b|\bbest\b|\bvs\.?\b|\breview\b|\bplans? to\b|\bplanning\b|\bcould\b|\bwill\b|\breportedly\b|\brumou?r\w*|\baccelerator\b|\bchips?\b|\bGPUs?\b|\bbuys\b|\bacquir\w*|\bdeal\b|\bexport rules\b|\bsoftware\b|\bSDKs?\b|\bmethod\b|\bsystem\b|\bopen[- ]sources? code\b|^What is\b|\bon Amazon Bedrock\b|\bon AWS\b|\bon Azure\b|\bon Vertex\b|\?$/i;

export const LABS = [
  ['meta', 'Meta', 'us', /\bMeta\b|\bLlama\b|\bMuse\b/],
  ['google', 'Google', 'us', /\bGoogle\b|\bDeepMind\b|\bGemma\b/],
  ['nvidia', 'Nvidia', 'us', /\bNvidia\b|\bNVIDIA\b|\bNemotron\b/],
  ['openai', 'OpenAI', 'us', /\bOpenAI\b|\bgpt-oss\b/],
  ['microsoft', 'Microsoft', 'us', /\bMicrosoft\b|\bPhi-\d/],
  ['ibm', 'IBM', 'us', /\bIBM\b|\bGranite\b/],
  ['ai2', 'Ai2', 'us', /\bAi2\b|\bAllen Institute\b|\bOLMo\b|\bMolmo\b/],
  ['apple', 'Apple', 'us', /\bApple\b/],
  ['amazon', 'Amazon', 'us', /\bAmazon\b|\bAWS\b/],
  ['thinkingmachines', 'Thinking Machines', 'us', /\bThinking Machines\b|\bInkling\b/],
  ['reflection', 'Reflection AI', 'us', /\bReflection(?: AI)?\b/],
  ['liquid', 'Liquid AI', 'us', /\bLiquid AI\b/],
  ['cloudflare', 'Cloudflare', 'us', /\bCloudflare\b/],
  ['huggingface', 'Hugging Face', 'us', /\bHugging Face\b(?=\s+(?:releases|launches|unveils|ships|introduces|drops|open-sources))|\bSmolLM\b/],
  ['xai', 'xAI', 'us', /\bxAI\b|\bGrok\b/],
  ['deepseek', 'DeepSeek', 'china', /\bDeepSeek\b/],
  ['qwen', 'Alibaba (Qwen)', 'china', /\bAlibaba\b|\bQwen\w*\b/],
  ['zhipu', 'Zhipu (GLM)', 'china', /\bZhipu\b|\bZ\.ai\b|\bGLM\b/],
  ['moonshot', 'Moonshot (Kimi)', 'china', /\bMoonshot\b|\bKimi\b/],
  ['minimax', 'MiniMax', 'china', /\bMiniMax\b/],
  ['stepfun', 'StepFun', 'china', /\bStepFun\b/],
  ['tencent', 'Tencent', 'china', /\bTencent\b|\bHunyuan\b/],
  ['baidu', 'Baidu', 'china', /\bBaidu\b|\bERNIE\b/],
  ['bytedance', 'ByteDance', 'china', /\bByteDance\b|\bSeed-OSS\b/],
  ['xiaomi', 'Xiaomi', 'china', /\bXiaomi\b|\bMiMo\b/],
  ['huawei', 'Huawei', 'china', /\bHuawei\b|\bPangu\b/],
  ['mistral', 'Mistral', 'europe', /\bMistral\b|\bMagistral\b|\bDevstral\b|\bMinistral\b|\bMixtral\b|\bVoxtral\b|\bCodestral\b|\bPixtral\b/],
  ['alephalpha', 'Aleph Alpha', 'europe', /\bAleph Alpha\b|\bKolibri\b/],
  ['swissai', 'Swiss AI (Apertus)', 'europe', /\bApertus\b|\bSwiss AI\b/],
  ['cohere', 'Cohere', 'other', /\bCohere\b|\bAya\b/],
  ['lg', 'LG (EXAONE)', 'other', /\bLG\b|\bEXAONE\b/],
  ['tii', 'TII (Falcon)', 'other', /\bTII\b|\bFalcon\b/],
  ['sarvam', 'Sarvam', 'other', /\bSarvam\b/],
  ['ai21', 'AI21', 'other', /\bAI21\b|\bJamba\b/],
];
export const REGIONS = [['us', 'United States'], ['china', 'China'], ['europe', 'Europe'], ['other', 'Elsewhere']];
const REGION_LABEL = Object.fromEntries(REGIONS);

export const MODALITIES = [
  ['speech', 'Speech and audio', /\bspeech\b|\bvoice\b|\baudio\b|\bTTS\b|\btext-to-speech\b|\btranscri\w*|\bdiarization\b|\bVoxtral\b/i],
  ['image', 'Images and video', /\bimage\b|\bvideo\b|\bdiffusion\b|\btext-to-image\b|\bImage-\d/i],
  ['code', 'Code and agents', /\bcod(?:e|ing|er)\b|\bagent\w*|\bDevstral\b|\bCodestral\b|\bsoftware engineering\b/i],
  ['vision', 'Vision and multimodal', /\bvision\b|\bmultimodal\b|\bVL\b|\bomni\b|\bvisual\b/i],
];
const MOD_LABEL = Object.fromEntries([...MODALITIES.map(([k, l]) => [k, l]), ['text', 'Text and reasoning']]);

export const LICENSES = [
  ['apache', 'Apache 2.0', /\bApache[- ]2\.0\b|\bApache\b/i],
  ['mit', 'MIT', /\bMIT\b(?:[- ]licen\w*)?/],
  ['custom', 'Custom or community license', /\bcommunity licen[sc]e\b|\bLlama licen[sc]e\b|\bresearch[- ]only\b|\bnon-commercial\b/i],
];
const LICENSE_LABEL = Object.fromEntries([...LICENSES.map(([k, l]) => [k, l]), ['unstated', 'Not stated']]);

// "600B MoE, 27B Active": the largest size not marked active, and the active one.
export function sizesOf(title) {
  let total = null;
  let active = null;
  for (const m of title.matchAll(/(?<![$€£\d.,])\b(\d+(?:\.\d+)?)\s?([BT]|[Bb]illion|[Tt]rillion)(?:[- ][Pp]aram\w*)?\b(\s*(?:total|active|activated)?)/g)) {
    const v = Number(m[1]) * (/^t/i.test(m[2]) ? 1000 : 1);
    if (!(v > 0) || v > 20000) continue;
    const after = title.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (/active/i.test(m[3]) || /^\s*(?:active|activated)\b/i.test(after)) active = Math.max(active || 0, v);
    else if (!/^\s*(?:tokens|users|downloads|dollars|valuation)\b/i.test(after)) total = Math.max(total || 0, v);
  }
  const a = title.match(/\bA(\d+(?:\.\d+)?)B\b/);
  if (a) active ??= Number(a[1]);
  if (active && total && active >= total) active = null;
  return { total, active };
}

export function contextOf(title) {
  const m = title.match(/\b(\d+(?:\.\d+)?)\s?([MK])(?:-token)? context\b|\b(\d+(?:\.\d+)?)\s?([MK])[- ]token (?:context|window)\b/i);
  if (!m) return null;
  const v = Number(m[1] || m[3]);
  return (m[2] || m[4]).toUpperCase() === 'M' ? v * 1e6 : v * 1e3;
}

// The model's name: the capitalised run after the verb, or a family and version.
export function modelName(title) {
  const after = title.split(VERB)[1];
  const cut = (s) => s
    .replace(/^\s*(?:(?:an?|its|their|the|new|first|latest|open[- ]?weights?|open[- ]source|open|fully|smaller|bigger|frontier|Apache[- ]2\.0|MIT)\s+)+/i, '')
    .split(/\.\s|\s\d+(?:\.\d+)?\s?(?:B|T|Billion|Trillion)\b/)[0]
    .split(/[,:;()]| - | — | – |\s(?:model|models|with|for|to|that|which|as|in|on|and|built|under|matching|beating|a|an|the|its)\b/i)[0]
    .replace(/\s+(?:Open|Weights?|Open-Weights?|LLM|MoE|AI)$/i, '')
    .trim();
  // A name has a version, a hyphen or a family in it ("Kimi K3", "LFM2.5-24B").
  const named = (s) => /^[A-Z0-9][\w.+-]*(?:\s[\w.+-]+){0,3}$/.test(s) && /[A-Z]/.test(s) && s.length <= 40 && (/\d|-/.test(s) || FAMILY.test(s) || /^[A-Z][a-z]+$/.test(s));
  if (after) {
    const s = cut(after).replace(/^\d+(?:\.\d+)?[BT](?:-parameter)?\s+/i, '').split(/\s(?:Without|Starting|Takes|Deploys|Tops|Is|Now|Faster|Smaller|Bigger|Open-Weight|Open-Source)\b/)[0].trim();
    if (named(s) && !/^(?:AI|Open|New|Model|Models|Speech|Powerhouse)$/i.test(s)) return s;
  }
  const f = title.match(new RegExp(`\\b(?:${FAMILIES})[\\w.-]*(?:[ -](?:[A-Z]?\\d[\\w.]*)){0,2}`));
  return f ? f[0].trim() : null;
}

export function parseRelease(rawTitle) {
  const { title } = splitOutlet(rawTitle.replace(/^\[[^\]]{1,30}\]\s*/, ''));
  if (!VERB.test(title) || NOT_MODEL.test(title)) return null;
  // Hosted, preview-only or weightless releases aren't open unless the headline says so.
  const open = OPEN.test(title) || (OPEN_FAMILY.test(title) && !/\bwithout (?:\S+ ){0,2}weights\b|\bhosted\b|\bAPI\b|\bpreviews?\b|\bclosed\b/i.test(title));
  if (!open || !(MODEL.test(title) || FAMILY.test(title))) return null;
  // The lab is the subject, named before the verb. Another company's model
  // built on a lab's weights is a derivative of that lab's.
  const verbAt = VERB.exec(title).index;
  let lab = null;
  let first = Infinity;
  for (const [key, label, region, re] of LABS) {
    const m = re.exec(title);
    if (m && m.index < first) { first = m.index; lab = { key, label, region }; }
  }
  if (!lab) return null;
  let builder = null;
  if (first > verbAt) {
    if (!DERIVED.test(title)) return null;
    builder = title.slice(0, verbAt).replace(/\b(?:AI|Labs?|Team|Inc)\s*$/i, '').trim().split(/\s+/).slice(-3).join(' ') || null;
    if (!builder || !/^[A-Z]/.test(builder) || /\b(?:Models?|Derivative|Half|Developers?)\b/.test(builder)) return null;
  }
  const name = modelName(title);
  const { total, active } = sizesOf(title);
  const modality = MODALITIES.find(([, , re]) => re.test(title))?.[0] || 'text';
  const license = LICENSES.find(([, , re]) => re.test(title))?.[0] || 'unstated';
  return { title, lab, builder, name, total, active, context: contextOf(title), modality, license };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};
const nameKey = (s) => (s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\b(?:preview|instruct|base|open|weights?)\b/g, '').trim();

export function computeOpen(db, now = Date.now(), days = OPEN_DAYS) {
  const since = now - days * DAY;
  const rows = db.prepare(`SELECT id, url, title, site, source, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND type IN ('article', 'post') AND published_at >= ? AND published_at <= ? AND hidden = 0
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(FTS, since, now + 5 * 60e3);
  const releases = [];
  let headlines = 0;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const { title, outlet } = splitOutlet(r.title);
    if (!/^[\x20-\x7E‘-”–—…$€£]+$/.test(title)) continue;
    const p = parseRelease(r.title);
    if (!p) continue;
    headlines++;
    const source = outlet || r.source || r.site;
    const toks = new Set(tokens(title));
    const key = nameKey(p.name);
    // The same lab's model within a month, or the same lab telling the same
    // story within three days when the name didn't parse.
    const same = releases.find((x) => x.lab.key === p.lab.key && !x.builder === !p.builder && r.at - x.last < 30 * DAY
      && ((key && x.keys.has(key)) || (r.at - x.last < 3 * DAY && overlap(toks, x.toks) >= 0.4)));
    if (same) {
      same.last = r.at;
      same.outlets.add(source);
      if (key) same.keys.add(key);
      for (const t of toks) same.toks.add(t);
      for (const k of ['total', 'active', 'context']) if (p[k] && (!same[k] || (k !== 'active' && p[k] > same[k]))) same[k] = p[k];
      if (same.modality === 'text') same.modality = p.modality;
      if (same.license === 'unstated') same.license = p.license;
      if (!same.name || (p.name && p.name.length < same.name.length && key && same.keys.has(key))) same.name ||= p.name;
      if (!same.reports.some((x) => overlap(toks, x.toks) >= 0.7)) same.reports.push({ at: r.at, title, url: r.url, source, toks });
      continue;
    }
    releases.push({ ...p, keys: new Set(key ? [key] : []), at: r.at, last: r.at, url: r.url, source, outlets: new Set([source]), toks, reports: [{ at: r.at, title, url: r.url, source, toks }] });
  }

  // A release needs a name, a size or a second outlet to stand.
  const all = releases.filter((x) => x.name || x.total || x.outlets.size >= 2).map((x) => ({
    id: `${x.builder ? 'on-' : ''}${x.lab.key}-${nameKey(x.name).replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'model'}-${new Date(x.at).toISOString().slice(0, 10)}`,
    at: x.at,
    last: x.last,
    lab: x.lab,
    builder: x.builder,
    name: x.name,
    total: x.total,
    active: x.active,
    context: x.context,
    modality: x.modality,
    license: x.license,
    title: x.title,
    url: x.url,
    source: x.source,
    outlets: x.outlets.size,
    reports: x.reports.slice(0, 8).map(({ toks, ...r }) => r),
  })).sort((a, b) => b.at - a.at);
  const out = all.filter((x) => !x.builder);
  const derived = all.filter((x) => x.builder);

  const months = [];
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ m: d.toISOString().slice(0, 7), n: 0, regions: Object.fromEntries(REGIONS.map(([k]) => [k, 0])) });
  }
  const mi = new Map(months.map((m, i) => [m.m, i]));
  for (const x of out) {
    const m = months[mi.get(new Date(x.at).toISOString().slice(0, 7))];
    if (!m) continue;
    m.n++;
    m.regions[x.lab.region]++;
  }

  const in90 = (x) => x.at >= now - 90 * DAY;
  const prev90 = (x) => x.at < now - 90 * DAY && x.at >= now - 180 * DAY;
  const labs = new Map();
  for (const x of out) {
    const l = labs.get(x.lab.key) || { ...x.lab, n: 0, n90: 0, outlets: 0, biggest: null, last: 0, modalities: {} };
    l.n++;
    if (in90(x)) l.n90++;
    l.outlets += x.outlets;
    if (x.total && (!l.biggest || x.total > l.biggest.total)) l.biggest = { name: x.name, total: x.total };
    l.last = Math.max(l.last, x.at);
    l.modalities[x.modality] = (l.modalities[x.modality] || 0) + 1;
    labs.set(l.key, l);
  }
  const sized = out.filter((x) => x.total);
  const r90 = out.filter(in90);
  const share = (region) => (r90.length ? r90.filter((x) => x.lab.region === region).length / r90.length : 0);
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    generatedAt: now,
    days,
    headlines,
    releases: out.slice(0, 400),
    months,
    regions: REGIONS.map(([key, label]) => ({ key, label, n: out.filter((x) => x.lab.region === key).length, n90: r90.filter((x) => x.lab.region === key).length, prev90: out.filter((x) => x.lab.region === key && prev90(x)).length })),
    labs: [...labs.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 20),
    sizes: sized.map((x) => ({ id: x.id, at: x.at, total: x.total, active: x.active, name: x.name, lab: x.lab, modality: x.modality })),
    modalities: [...MODALITIES.map(([k]) => k), 'text'].map((key) => ({ key, label: MOD_LABEL[key], n: out.filter((x) => x.modality === key).length })),
    licenses: [...LICENSES.map(([k]) => k), 'unstated'].map((key) => ({ key, label: LICENSE_LABEL[key], n: out.filter((x) => x.license === key).length })),
    // Whose open weights other companies build on.
    builtOn: [...derived.reduce((m, x) => m.set(x.lab.key, [...(m.get(x.lab.key) || []), x]), new Map())].map(([key, list]) => ({ key, label: list[0].lab.label, region: list[0].lab.region, n: list.length, builders: list.map((x) => ({ id: x.id, at: x.at, builder: x.builder, name: x.name, title: x.title, url: x.url })) })).sort((a, b) => b.n - a.n),
    labels: { regions: REGION_LABEL, modalities: MOD_LABEL, licenses: LICENSE_LABEL },
    stats: {
      releases: out.length,
      n90: r90.length,
      prev90: out.filter(prev90).length,
      chinaShare90: share('china'),
      usShare90: share('us'),
      labs: labs.size,
      biggest: sized.length ? sized.reduce((a, b) => (b.total > a.total ? b : a)) : null,
      medianTotal90: median(r90.filter((x) => x.total).map((x) => x.total)),
      medianTotalPrev: median(out.filter((x) => x.total && !in90(x)).map((x) => x.total)),
      moeShare: sized.length ? sized.filter((x) => x.active).length / sized.length : 0,
    },
  };
}

export const openQuery = () => cachedJob('open', { kind: 'open' }, TTL_MS);
