// Recent AI releases: models from the last 90 days.
//   OpenRouter lists API models within hours of launch, with context, prices
//     and (for open models) the Hugging Face repo.
//   Hugging Face, polled per major lab, catches open-weight releases that never
//     reach OpenRouter (image, speech, small models).
// Both are merged by Hugging Face repo, and size variants of one family
// (8B, 32B, 235B...) collapse into a single release.

import { getJSON, pool } from '../http.js';
import { RELEASES } from '../config.js';
import { clip, decodeEntities, stripHtml } from '../pipeline/text.js';

const DAY = 86400e3;
const norm = (s = '') => s.toLowerCase();

// "Qwen3.5-235B-A22B-Instruct-2507" -> "qwen3.5": one family per release line.
export function familyOf(name) {
  return norm(name)
    .replace(/^[^/]+\//, '')
    .replace(/[-_ ](\d+(\.\d+)?[bm](-a\d+(\.\d+)?b)?|instruct|base|chat|it|preview|thinking|fp8|bf16|gguf|awq|gptq|mlx|\d{4})\b.*$/, '')
    .replace(/[-_ ]+$/, '');
}

// Repo names are often all lowercase ("flux-3-image-klein"); title-case those.
const prettyName = (repo) => {
  const words = repo.replace(/[-_]+/g, ' ');
  return words === words.toLowerCase() ? words.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : words;
};

const QUANT = /gguf|awq|gptq|[-_]n?fp[48]|[-_]int[48]|[-_]4bit|[-_]8bit|mlx|onnx|exl2|[-_]nf4|[-_]local\b/i;

function fromOpenRouter(models, since) {
  const out = new Map();
  for (const m of models) {
    const id = m.id.split(':')[0];
    if (m.id.startsWith('~') || /latest$|^openrouter\//.test(id) || m.created * 1000 < since || out.has(id)) continue;
    const [provider, ...rest] = decodeEntities(m.name).split(': ');
    const name = (rest.join(': ') || provider).replace(/\s*\((free|beta|extended|thinking)\)$/i, '');
    const price = (p) => (p != null && Number(p) >= 0 ? Number(p) * 1e6 : null);
    out.set(id, {
      id: `or:${id}`,
      name,
      provider: rest.length ? provider : id.split('/')[0],
      org: id.split('/')[0],
      date: m.created * 1000,
      url: `https://openrouter.ai/${id}`,
      api: true,
      open: !!m.hugging_face_id,
      hf: m.hugging_face_id || null,
      context: m.context_length || null,
      priceIn: price(m.pricing?.prompt),
      priceOut: price(m.pricing?.completion),
      modality: m.architecture?.output_modalities?.includes('image') ? 'image' : (m.architecture?.input_modalities || []).includes('image') ? 'vision' : 'text',
      summary: clip(stripHtml(m.description || ''), 220),
    });
  }
  return [...out.values()];
}

async function fromHuggingFace(since) {
  const { results, errors } = await pool(RELEASES.hfOrgs, 6, async ([org, provider]) => {
    const list = await getJSON(`https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=40`);
    return list
      .filter((m) => Date.parse(m.createdAt) >= since && !QUANT.test(m.id))
      // Fresh releases haven't gathered many likes yet.
      .filter((m) => (m.likes || 0) >= (Date.now() - Date.parse(m.createdAt) < 3 * DAY ? RELEASES.minLikesFresh : RELEASES.minLikes))
      .map((m) => ({
        id: `hf:${m.id}`,
        name: prettyName(m.id.split('/')[1]),
        provider,
        org: org.toLowerCase(),
        date: Date.parse(m.createdAt),
        url: `https://huggingface.co/${m.id}`,
        api: false,
        open: true,
        hf: m.id,
        likes: m.likes || 0,
        modality: /image|video/.test(m.pipeline_tag || '') && !/to-text/.test(m.pipeline_tag || '') ? 'image' : /speech|audio/.test(m.pipeline_tag || '') ? 'audio' : /image-text|vision/.test(m.pipeline_tag || '') ? 'vision' : 'text',
      }));
  });
  return { list: results.flat(), errors };
}

// One entry per family: the API listing wins (it has prices and context);
// Hugging Face sizes fold in as variants.
const firstWord = (r) => norm(r.hf ? r.hf.split('/')[1] : r.name).split(/[-_ .]/)[0];
const NOTABLE = new Set(RELEASES.notable);

export function mergeReleases(orList, hfList) {
  const byFamily = new Map();
  const add = (r) => {
    // OpenRouter and Hugging Face name labs differently ("z-ai", "zai-org"),
    // so a release with weights is keyed by its repo's owner.
    let key = `${(r.hf ? r.hf.split('/')[0] : r.org).toLowerCase()}|${familyOf(r.hf || r.name)}`;
    // Hugging Face-only uploads from one lab line within a few days (checkpoint
    // dumps, size and format variants) fold into the most-liked one.
    if (!r.api && !byFamily.has(key)) {
      const sibling = [...byFamily.entries()].find(([, p]) => !p.api && p.org === r.org && firstWord(p) === firstWord(r) && Math.abs(p.date - r.date) < 3 * DAY);
      if (sibling) key = sibling[0];
    }
    const prev = byFamily.get(key);
    if (!prev) return byFamily.set(key, { ...r, sizes: r.hf ? [r.hf] : [] });
    const api = prev.api ? prev : r.api ? r : prev;
    const merged = {
      ...api,
      date: Math.min(prev.date, r.date),
      open: prev.open || r.open,
      api: prev.api || r.api,
      likes: Math.max(prev.likes || 0, r.likes || 0),
      sizes: [...new Set([...prev.sizes, ...(r.hf ? [r.hf] : [])])],
    };
    if (!merged.api) merged.name = (prev.likes || 0) >= (r.likes || 0) ? prev.name : r.name;
    byFamily.set(key, merged);
  };
  for (const r of orList) add(r);
  for (const r of [...hfList].sort((a, b) => (b.likes || 0) - (a.likes || 0))) add(r);
  return [...byFamily.values()]
    .map((r) => ({ ...r, notable: NOTABLE.has(r.org) }))
    .sort((a, b) => b.date - a.date);
}

export async function fetchReleases() {
  const since = Date.now() - RELEASES.days * DAY;
  const errors = [];
  let or = [];
  try {
    or = fromOpenRouter((await getJSON('https://openrouter.ai/api/v1/models')).data, since);
  } catch (err) {
    errors.push({ item: 'openrouter', error: err.message });
  }
  const hf = await fromHuggingFace(since).catch((err) => ({ list: [], errors: [{ item: 'huggingface', error: err.message }] }));
  errors.push(...hf.errors);
  return { releases: mergeReleases(or, hf.list), errors };
}
