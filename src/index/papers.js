// Research papers: what AI researchers are publishing, from the Hugging Face
// paper pages the crawler stores (~400–1,000 a month). Each paper's title is
// read for research themes (a paper can have several), month-by-month shares
// of each theme are kept for a year, words that are suddenly common in the
// last 30 days' titles are compared with the 90 days before, and papers whose
// name (the part before the colon: "Matrix-Game 4.0") turned up in news
// headlines are listed with those headlines.

import { tokens, hostOf } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
const PREFIX = /^Paper page - /;

export const THEMES = [
  ['agents', 'Agents and tool use', /\bagent\w*|\btool[- ]use\b|\btool[- ]calling\b|\bcomputer[- ]use\b|\bweb (?:navigation|browsing)\b|\bGUI\b|\bmulti-agent\b|\bplanning\b|\bswarm\b/i],
  ['reasoning', 'Reasoning and RL', /\breason\w*|\bchain[- ]of[- ]thought\b|\bCoT\b|\breinforcement\b|\bRLVR\b|\bRLHF\b|\bGRPO\b|\bpolicy optimi[sz]ation\b|\breward\w*|\bthinking\b|\btest[- ]time\b|\bself[- ](?:improv|verif|reflect)\w*/i],
  ['vision', 'Vision and multimodal', /\bvision\b|\bvisual\b|\bimages?\b|\bVLMs?\b|\bmultimodal\b|\bMLLMs?\b|\bvideo understanding\b|\bOCR\b|\bdocuments?\b|\bperception\b|\bspatial\b/i],
  ['generation', 'Image, video and 3D generation', /\bdiffusion\b|\bgenerat\w* (?:\S+ ){0,2}(?:images?|videos?|3D|scenes?|worlds?|music|audio|speech)\b|\bvideo (?:generation|models?|synthesis)\b|\btext-to-(?:image|video|3D|speech|audio)\b|\b3D\b|\brender\w*|\bworld models?\b|\bavatars?\b|\bediting\b|\bflow matching\b/i],
  ['robotics', 'Robotics and embodied AI', /\brobot\w*|\bembodied\b|\bmanipulation\b|\bVLAs?\b|\bvision-language-action\b|\bnavigation\b|\bdriving\b|\bautonomous\b|\bhumanoid\w*|\blocomotion\b|\bsim-to-real\b/i],
  ['efficiency', 'Efficiency and architecture', /\befficien\w*|\bquantiz\w*|\bsparse\b|\bsparsity\b|\bcompress\w*|\bdistill\w*|\bKV[- ]cache\b|\binference\b|\bspeculative\b|\bmixture[- ]of[- ]experts\b|\bMoE\b|\blong[- ]context\b|\battention\b|\blinear\b|\bstate[- ]space\b|\bMamba\b|\bpruning\b|\bscaling\b|\barchitecture\b|\btokeni[sz]\w*/i],
  ['safety', 'Safety, alignment and trust', /\bsafety\b|\bsafe\b|\balign\w*|\bjailbreak\w*|\bharmful\b|\brobust\w*|\bhallucinat\w*|\bbias\w*|\bprivacy\b|\battacks?\b|\badversarial\b|\bunlearning\b|\binterpretab\w*|\bfaithful\w*|\bwatermark\w*|\bdeception\b|\bmisalign\w*/i],
  ['code', 'Code and maths', /\bcode\b|\bcoding\b|\bsoftware\b|\bprogram\w*|\bSWE\b|\brepository\b|\bmath\w*|\btheorem\w*|\bproofs?\b|\bLean\b|\bformal\w*|\bolympiad\b/i],
  ['data', 'Benchmarks and data', /\bbenchmark\w*|\bdatasets?\b|\bevaluat\w*|\bleaderboard\b|\bcorpus\b|\bsynthetic data\b|\bdata (?:curation|generation|mixture|selection)\b|\bmeasur\w*/i],
];
const THEME_LABEL = Object.fromEntries(THEMES.map(([k, l]) => [k, l]));

export const themesOf = (title) => THEMES.filter(([, , re]) => re.test(title)).map(([k]) => k);

// "Matrix-Game 4.0: Harnessing…" -> "Matrix-Game 4.0": a short name before a
// colon that isn't a generic phrase.
const GENERIC = /^(?:towards?|beyond|rethinking|revisiting|understanding|when|why|how|what|is|are|do|does|can|on|from|the|a|an|less is more|all you need|position|survey|review|technical report)\b/i;
export function nameOf(title) {
  const m = /^([^:]{3,32}):\s/.exec(title);
  if (!m) return null;
  const n = m[1].trim();
  if (GENERIC.test(n) || n.split(/\s+/).length > 4 || !/[A-Z]/.test(n)) return null;
  return n;
}

export function computePapers(db, now = Date.now()) {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() - 11);
  const since = Math.min(start.getTime(), now - 120 * DAY);
  const rows = db.prepare(`SELECT title, url, published_at AS at FROM docs INDEXED BY docs_site
    WHERE site = 'huggingface.co' AND title LIKE 'Paper page - %' AND published_at >= ? AND published_at <= ? AND hidden = 0
    ORDER BY published_at DESC`).all(since, now + 5 * 60e3);
  const months = [];
  for (let d = new Date(start); d.getTime() <= now; d.setUTCMonth(d.getUTCMonth() + 1)) months.push({ m: d.toISOString().slice(0, 7), n: 0, themes: Object.fromEntries(THEMES.map(([k]) => [k, 0])) });
  const mi = new Map(months.map((m, i) => [m.m, i]));
  const seen = new Set();
  const papers = [];
  const recentWords = new Map();
  const olderWords = new Map();
  let recentN = 0;
  let olderN = 0;
  for (const r of rows) {
    const title = r.title.replace(PREFIX, '').trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    const themes = themesOf(title);
    const p = { title, url: r.url, at: r.at, themes, name: nameOf(title) };
    papers.push(p);
    const m = months[mi.get(new Date(r.at).toISOString().slice(0, 7))];
    if (m) {
      m.n++;
      for (const t of themes) m.themes[t]++;
    }
    // Words in titles: the last 30 days against the 90 before.
    const age = now - r.at;
    const into = age < 30 * DAY ? recentWords : age < 120 * DAY ? olderWords : null;
    if (into) {
      if (into === recentWords) recentN++;
      else olderN++;
      for (const w of new Set(tokens(title).filter((t) => t.length > 2 && !/^\d+(?:\.\d+)?$/.test(t)))) into.set(w, (into.get(w) || 0) + 1);
    }
  }

  // Rising words: share of recent titles against share of older ones.
  const rising = [];
  for (const [w, n] of recentWords) {
    if (n < 8) continue;
    const share = n / Math.max(1, recentN);
    const prev = (olderWords.get(w) || 0) / Math.max(1, olderN);
    const lift = (share + 0.002) / (prev + 0.002);
    if (lift >= 1.8) rising.push({ w, n, prev: olderWords.get(w) || 0, lift: Math.round(lift * 10) / 10 });
  }
  rising.sort((a, b) => b.lift - a.lift || b.n - a.n);

  // Papers in the news: a named paper from the last 60 days whose name a news
  // headline (not Hugging Face or arXiv) carries as written. News titles are
  // read once (title, URL and date sit before the body; site doesn't) and
  // indexed by word, so each name is checked against the few headlines that
  // contain its rarest word instead of one search per paper (~5 ms each).
  const newsRows = db.prepare(`SELECT title, url, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type IN ('article', 'post') AND published_at >= ? AND published_at <= ? AND hidden = 0`).all(now - 63 * DAY, now + 5 * 60e3)
    .filter((r) => r.title && !/huggingface\.co|arxiv\.org/.test(r.url) && !PREFIX.test(r.title));
  const byWord = new Map();
  newsRows.forEach((r, i) => {
    for (const w of new Set(tokens(r.title))) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(i);
    }
  });
  const inNews = [];
  for (const p of papers) {
    if (now - p.at > 60 * DAY || !p.name || p.name.length < 5) continue;
    const words = tokens(p.name);
    if (!words.length) continue;
    // A plain word ("Foresight", "Mosaic") names many things; it needs two
    // more words from the paper's title in the headline too.
    const distinctive = /\d|-|[a-z][A-Z]/.test(p.name);
    const rare = words.reduce((a, w) => ((byWord.get(w)?.length ?? 0) < (byWord.get(a)?.length ?? 0) ? w : a), words[0]);
    const lname = p.name.toLowerCase();
    const titleWords = new Set(tokens(p.title).filter((w) => !words.includes(w) && w.length > 3));
    const hits = (byWord.get(rare) || []).map((i) => newsRows[i])
      .filter((h) => h.at >= p.at - 3 * DAY && h.title.toLowerCase().includes(lname)
        && (distinctive || tokens(h.title).filter((w) => titleWords.has(w)).length >= 2))
      .sort((a, b2) => a.at - b2.at)
      .slice(0, 6);
    if (hits.length) inNews.push({ ...p, news: hits.map((h) => ({ title: h.title, url: h.url, source: hostOf(h.url).replace(/^www\./, ''), at: h.at })) });
    if (inNews.length >= 20) break;
  }

  const last = months.at(-1);
  const prev = months.at(-2);
  const share = (m, k) => (m?.n ? m.themes[k] / m.n : 0);
  return {
    generatedAt: now,
    months,
    themes: THEMES.map(([key, label]) => ({
      key,
      label,
      n: months.reduce((a, m) => a + m.themes[key], 0),
      share: share(last, key) + share(prev, key) ? (last.themes[key] + prev.themes[key]) / Math.max(1, last.n + prev.n) : 0,
    })),
    rising: rising.slice(0, 20),
    inNews,
    latest: papers.slice(0, 300).map(({ title, url, at, themes, name }) => ({ title, url, at, themes, name })),
    labels: { themes: THEME_LABEL },
    stats: {
      papers: papers.length,
      last30: papers.filter((p) => now - p.at < 30 * DAY).length,
      prev30: papers.filter((p) => now - p.at >= 30 * DAY && now - p.at < 60 * DAY).length,
      inNews: inNews.length,
    },
  };
}

export const papersQuery = () => cachedJob('papers', { kind: 'papers' }, TTL_MS);
