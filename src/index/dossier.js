// Company dossiers (#co/<key>): everything the site tracks about one AI
// company on one page. Nothing new is computed; the cached results of other
// pages are filtered to the company: its share of coverage (topics), the mood
// of its headlines, its funding and valuations (deals), the figures put on it
// (numbers), what it shipped, its incidents, lawsuits, layoffs and open
// releases, and dates ahead. They merge into one timeline. Each part is
// optional, so a page that's still computing just leaves its part out.

const DAY = 86400e3;

// How each page names the company.
export const DOSSIERS = {
  openai: { label: 'OpenAI', topic: 'openai', mood: 'openai', numbers: 'openai', shipped: ['chatgpt', 'codex'], incidents: ['chatgpt'], open: ['openai'], court: ['openai'], jobs: ['openai'], deals: 'openai', match: /\bOpenAI\b|\bChatGPT\b|\bGPT-\w+|\bCodex\b|\bSam Altman\b/ },
  anthropic: { label: 'Anthropic', topic: 'anthropic', mood: 'anthropic', numbers: 'anthropic', shipped: ['claude', 'claude-code'], incidents: ['claude'], open: [], court: ['anthropic'], jobs: ['anthropic'], deals: 'anthropic', match: /\bAnthropic\b|\bClaude\b|\bDario Amodei\b/ },
  google: { label: 'Google', topic: 'google', mood: 'google', numbers: 'google', shipped: ['gemini'], incidents: ['gemini'], open: ['google'], court: ['google', 'alphabet'], jobs: ['google', 'alphabet'], deals: 'google', match: /\bGoogle\b|\bGemini\b|\bDeepMind\b|\bAlphabet\b/ },
  meta: { label: 'Meta', topic: 'meta', mood: 'meta', numbers: 'meta', shipped: ['meta'], incidents: ['meta'], open: ['meta'], court: ['meta'], jobs: ['meta'], deals: 'meta', match: /\bMeta\b|\bLlama\b|\bMuse\b|\bZuckerberg\b/ },
  microsoft: { label: 'Microsoft', topic: 'microsoft', mood: 'microsoft', numbers: 'microsoft', shipped: ['copilot'], incidents: ['copilot'], open: ['microsoft'], court: ['microsoft'], jobs: ['microsoft'], deals: 'microsoft', match: /\bMicrosoft\b|\bCopilot\b|\bAzure\b/ },
  xai: { label: 'xAI', topic: 'xai', mood: 'xai', numbers: 'xai', shipped: ['grok'], incidents: ['grok'], open: ['xai'], court: ['xai'], jobs: ['xai'], deals: 'xai', match: /\bxAI\b|\bGrok\b/ },
  nvidia: { label: 'Nvidia', topic: 'nvidia', mood: 'nvidia', numbers: 'nvidia', shipped: [], incidents: [], open: ['nvidia'], court: ['nvidia'], jobs: ['nvidia'], deals: 'nvidia', match: /\bNvidia\b|\bNVIDIA\b|\bJensen Huang\b/ },
  amazon: { label: 'Amazon', topic: 'amazon', mood: 'amazon', numbers: 'amazon', shipped: ['alexa'], incidents: ['amazon'], open: ['amazon'], court: ['amazon'], jobs: ['amazon'], deals: 'amazon', match: /\bAmazon\b|\bAWS\b|\bAlexa\b/ },
  apple: { label: 'Apple', topic: 'apple', mood: 'apple', numbers: 'apple', shipped: ['siri'], incidents: ['apple'], open: ['apple'], court: ['apple'], jobs: ['apple'], deals: 'apple', match: /\bApple\b|\bSiri\b/ },
  deepseek: { label: 'DeepSeek', topic: 'deepseek', mood: 'deepseek', numbers: null, shipped: [], incidents: ['deepseek'], open: ['deepseek'], court: ['deepseek'], jobs: [], deals: 'deepseek', match: /\bDeepSeek\b/ },
  mistral: { label: 'Mistral', topic: 'mistral', mood: 'mistral', numbers: 'mistral', shipped: [], incidents: [], open: ['mistral'], court: ['mistral'], jobs: [], deals: 'mistral', match: /\bMistral\b/ },
};
export const dossierKeys = () => Object.keys(DOSSIERS);

// parts: { topic, mood, deals, numbers, shipped, incidents, open, court, jobs, ahead }
export function buildDossier(key, parts, now = Date.now()) {
  const c = DOSSIERS[key];
  if (!c) return null;
  const since = now - 120 * DAY;
  const timeline = [];
  const push = (x) => { if (x.at >= since && x.at <= now + 5 * 60e3) timeline.push(x); };

  const figures = (parts.numbers?.points || []).filter((p) => p.company === c.numbers);
  for (const p of figures) push({ at: p.at, type: 'figure', title: p.title, url: p.url, source: p.source, detail: parts.numbers.labels.metrics[p.metric] });
  const shipped = (parts.shipped?.entries || []).filter((x) => c.shipped.includes(x.product));
  for (const x of shipped) push({ at: x.at, type: 'shipped', title: x.title, url: x.url, source: x.source, detail: parts.shipped.labels.kinds[x.kind], outlets: x.outlets });
  const incidents = (parts.incidents?.incidents || []).filter((x) => c.incidents.includes(x.product?.key));
  for (const x of incidents) push({ at: x.at, type: 'incident', title: x.title, url: x.url, source: x.source, detail: parts.incidents.labels.kinds[x.kind], outlets: x.outlets });
  const releases = (parts.open?.releases || []).filter((x) => c.open.includes(x.lab.key));
  for (const x of releases) push({ at: x.at, type: 'open', title: x.title, url: x.url, source: x.source, detail: x.name ? `Open weights: ${x.name}` : 'Open weights', outlets: x.outlets });
  const cases = (parts.court?.cases || []).filter((x) => c.court.includes(x.defendant?.key));
  for (const x of cases) for (const e of (x.events || []).slice(-3)) push({ at: e.at, type: 'court', title: e.title, url: e.url, source: e.source || '', detail: `Court: ${e.kind}` });
  const cuts = (parts.jobs?.cuts || []).filter((x) => c.jobs.includes(x.company?.key));
  for (const x of cuts) push({ at: x.at, type: 'jobs', title: x.reports?.[0]?.title || `${x.company.label} cuts`, url: x.reports?.[0]?.url, source: x.reports?.[0]?.source || '', detail: x.count ? `${x.count.toLocaleString('en')} jobs` : 'Job cuts', outlets: x.outlets });
  const deals = parts.deals?.deals || [];
  for (const x of deals) push({ at: x.at, type: 'deal', title: x.first?.title || x.company, url: x.first?.url, source: x.first?.source || '', detail: x.kind === 'acquisition' ? 'Acquisition' : x.round || 'Funding', outlets: x.outlets });
  timeline.sort((a, b) => b.at - a.at);
  // One entry per story across the parts (a launch can also be a figure).
  const seen = new Set();
  const merged = timeline.filter((x) => {
    const k = (x.url || x.title).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const ahead = (parts.ahead?.items || []).filter((x) => x.kind !== 'market' && c.match.test(x.title)).slice(0, 8);
  const mood = (parts.mood?.companies || []).find((m) => m.key === c.mood) || null;
  const latestFigures = (parts.numbers?.board || []).map((b) => ({ metric: b.metric, label: b.label, row: b.companies.find((r) => r.company === c.numbers) })).filter((x) => x.row).map((x) => ({ metric: x.metric, label: x.label, latest: x.row.latest, history: x.row.history }));
  const share = parts.topic?.series || null;
  const shareNow = share ? share.slice(-7).reduce((a, d) => a + d.n, 0) / Math.max(1, share.slice(-7).reduce((a, d) => a + d.total, 0)) : null;
  const sharePrev = share ? share.slice(-14, -7).reduce((a, d) => a + d.n, 0) / Math.max(1, share.slice(-14, -7).reduce((a, d) => a + d.total, 0)) : null;
  const counts = {};
  for (const x of merged) counts[x.type] = (counts[x.type] || 0) + 1;
  return {
    key,
    label: c.label,
    generatedAt: now,
    share: share ? { series: share.map((d) => ({ day: d.day, share: d.share, n: d.n })), week: shareNow, prevWeek: sharePrev } : null,
    mood: mood ? { mood90: mood.mood90, moodPrev: mood.moodPrev, moodWeek: mood.moodWeek, weeks: mood.weeks, good: mood.good, bad: mood.bad, weekStarts: (parts.mood.series || []).map((s) => s.start) } : null,
    money: parts.deals ? { raised: parts.deals.raised || 0, valuations: parts.deals.valuations || [] } : null,
    figures: latestFigures,
    timeline: merged.slice(0, 80),
    counts,
    ahead,
    stats: {
      shipped30: shipped.filter((x) => x.at >= now - 30 * DAY).length,
      incidents90: incidents.filter((x) => x.at >= now - 90 * DAY).length,
      openCases: cases.filter((x) => x.status !== 'settled').length,
      releases90: releases.filter((x) => x.at >= now - 90 * DAY).length,
    },
  };
}
