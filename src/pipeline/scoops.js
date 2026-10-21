// Who breaks news first. For every story with two or more original sources,
// the earliest one gets the credit, with its lead over the next source.
// Hacker News and Reddit relay other people's links, so they're neither
// credited nor used as the baseline. Leads past 12 hours are treated as old
// background pieces clustered into a new story (real races are minutes to
// hours), and leads under 5 minutes as a tie.

const RELAYS = new Set(['hn', 'reddit']);
const MIN_LEAD = 5 * 60e3;
const MAX_LEAD = 12 * 3600e3;

const keyOf = (s) => (s.platform === 'x' || s.platform === 'bluesky' ? `${s.platform}:${s.name.toLowerCase()}` : `web:${s.name}`);

// The story's first reporter and lead, or null when it's a tie or unclear.
export function firstReport(story) {
  const originals = story.sources.filter((s) => !RELAYS.has(s.platform) && s.publishedAt);
  if (originals.length < 2) return null;
  const [first, ...rest] = [...originals].sort((a, b) => a.publishedAt - b.publishedAt);
  const next = rest.find((s) => keyOf(s) !== keyOf(first));
  if (!next) return null;
  const lead = next.publishedAt - first.publishedAt;
  if (lead < MIN_LEAD || lead > MAX_LEAD) return null;
  return { name: first.name, platform: first.platform, avatar: first.avatar || null, host: first.host || null, url: first.url, leadMin: Math.round(lead / 60e3), next: next.name };
}

export function scoopBoard(stories, { limit = 12 } = {}) {
  const by = new Map();
  for (const s of stories) {
    const f = s.first;
    if (!f) continue;
    const k = keyOf(f);
    if (!by.has(k)) by.set(k, { name: f.name, platform: f.platform, avatar: f.avatar, host: f.host, leads: [], stories: [] });
    const e = by.get(k);
    e.avatar ||= f.avatar;
    e.leads.push(f.leadMin);
    e.stories.push({ id: s.id, title: s.title, leadMin: f.leadMin });
  }
  return [...by.values()]
    .map(({ leads, stories: st, ...e }) => {
      const sorted = [...leads].sort((a, b) => a - b);
      return { ...e, firsts: leads.length, medianLeadMin: sorted[Math.floor(sorted.length / 2)], stories: st.sort((a, b) => b.leadMin - a.leadMin).slice(0, 3) };
    })
    .sort((a, b) => b.firsts - a.firsts || b.medianLeadMin - a.medianLeadMin)
    .slice(0, limit);
}
