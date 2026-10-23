// Headline tone: does a headline read as good news or bad news? Counted from
// evaluative words (a lawsuit, a record, a breach, a breakthrough), not from
// what the story is about, so "OpenAI launches" is neutral and "OpenAI sued"
// is negative. A word list is crude next to a model, but it is fast enough to
// read a year of headlines, explainable (every score lists its words) and
// stable, which is what a trend line over months needs.

const POS = [
  'breakthrough', 'breakthroughs', 'record', 'records', 'soar', 'soars', 'soared', 'soaring', 'surge', 'surges', 'surged', 'surging', 'jump', 'jumps', 'jumped',
  'rally', 'rallies', 'win', 'wins', 'won', 'winning', 'winner', 'beat', 'beats', 'boost', 'boosts', 'boosted', 'success', 'successful', 'succeeds',
  'thrive', 'thrives', 'thriving', 'milestone', 'milestones', 'profit', 'profits', 'profitable', 'growth', 'grows', 'gain', 'gains', 'upgrade', 'upgrades',
  'celebrate', 'celebrates', 'excited', 'exciting', 'promising', 'impressive', 'remarkable', 'stunning', 'praise', 'praised', 'praises', 'hails', 'hailed',
  'improve', 'improves', 'improved', 'improvement', 'better', 'best', 'faster', 'cheaper', 'smarter', 'safer', 'saves', 'save', 'helps', 'help', 'empower',
  'empowers', 'opportunity', 'opportunities', 'approve', 'approves', 'approved', 'approval', 'hope', 'hopes', 'hopeful', 'optimism', 'optimistic',
  'boom', 'booming', 'tops', 'leads', 'leading', 'outperforms', 'outperform', 'cure', 'cures', 'transform', 'transforms', 'revolutionize', 'revolutionary',
  'game-changer', 'unlock', 'unlocks', 'accelerate', 'accelerates', 'strong', 'stronger', 'robust', 'wow', 'love', 'loves', 'easier', 'free', 'welcome',
  'welcomes', 'partners', 'partnership', 'expands', 'expansion', 'secures', 'raises', 'triumph', 'victory', 'restores', 'fixes', 'resolved', 'rises', 'rose', 'rising', 'climbs',
];
const NEG = [
  'lawsuit', 'lawsuits', 'sue', 'sues', 'sued', 'suing', 'fail', 'fails', 'failed', 'failure', 'failures', 'layoff', 'layoffs', 'cuts', 'crash', 'crashes',
  'crashed', 'plunge', 'plunges', 'plunged', 'slump', 'slumps', 'falls', 'fall', 'fell', 'drop', 'drops', 'dropped', 'tumble', 'tumbles', 'sink', 'sinks',
  'concern', 'concerns', 'concerned', 'warn', 'warns', 'warning', 'warnings', 'risk', 'risks', 'risky', 'danger', 'dangers', 'dangerous', 'threat', 'threats',
  'threaten', 'threatens', 'ban', 'bans', 'banned', 'probe', 'probes', 'investigation', 'investigates', 'investigating', 'breach', 'breaches', 'leak',
  'leaks', 'leaked', 'hack', 'hacked', 'hackers', 'outage', 'outages', 'backlash', 'criticism', 'criticize', 'criticizes', 'criticized', 'slams', 'slammed',
  'blasts', 'fear', 'fears', 'scandal', 'fraud', 'scam', 'scams', 'fake', 'deepfake', 'deepfakes', 'harm', 'harms', 'harmful', 'kill', 'kills', 'killed',
  'death', 'deaths', 'dies', 'died', 'suicide', 'problem', 'problems', 'flaw', 'flaws', 'flawed', 'bug', 'bugs', 'glitch', 'delay', 'delays', 'delayed',
  'struggle', 'struggles', 'struggling', 'lose', 'loses', 'losing', 'loss', 'losses', 'lost', 'worst', 'worse', 'bubble', 'collapse', 'collapses', 'crisis',
  'accuse', 'accuses', 'accused', 'fine', 'fined', 'penalty', 'misinformation', 'disinformation', 'hallucination', 'hallucinations', 'bias', 'biased',
  'worry', 'worries', 'worried', 'alarm', 'alarming', 'chaos', 'mess', 'disaster', 'doom', 'shutdown', 'halt', 'halts', 'halted', 'reject', 'rejects',
  'rejected', 'quit', 'quits', 'resigns', 'exodus', 'down', 'slowdown', 'decline', 'declines', 'declining', 'shortage', 'shortages', 'vulnerable',
  'vulnerability', 'exploit', 'exploited', 'abuse', 'abused', 'victims', 'victim', 'blame', 'blamed', 'controversy', 'controversial', 'chaotic', 'turmoil',
  'cheating', 'cheat', 'steal', 'stole', 'stolen', 'theft', 'violates', 'violation', 'illegal', 'arrested', 'charged', 'guilty', 'crackdown', 'dystopian',
  'scary', 'terrifying', 'panic', 'rogue', 'deceptive', 'manipulate', 'manipulation', 'mislead', 'misleading', 'overhyped', 'hype', 'wrong', 'broken',
  'disappointing', 'disappoints', 'flop', 'flops', 'backfires', 'sabotage', 'war', 'battle', 'fight', 'fights', 'clash', 'clashes', 'feud', 'tension', 'lagging', 'lags',
];
const POS_SET = new Set(POS);
const NEG_SET = new Set(NEG);
// Words that flip or blunt what follows within two words: "no risk", "not a bubble".
const NEGATORS = new Set(['no', 'not', "isn't", "aren't", "won't", "doesn't", "don't", 'never', 'without', 'despite', 'beyond', 'against', 'anti']);
// Senses that aren't evaluative: "fine-tune", "free tier", "help center", "record label".
const SKIP_NEXT = { fine: /^(?:-?tun\w*|print)$/, free: /^(?:tier|plan|trial|version)$/, help: /^(?:center|desk)$/, record: /^(?:label|player)$/, down: /^(?:to|on|under)$/, fall: /^(?:semester|season|lineup)$/, drop: /^(?:in|by|off)$/ };

const words = (s) => s.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z][a-z'-]*/g) || [];

// { score: -1..1, pos: [words], neg: [words] } for one headline.
export function toneOf(title) {
  const w = words(title);
  const pos = [];
  const neg = [];
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (!POS_SET.has(t) && !NEG_SET.has(t)) continue;
    if (SKIP_NEXT[t]?.test(w[i + 1] || '')) continue;
    const negated = NEGATORS.has(w[i - 1]) || NEGATORS.has(w[i - 2]);
    const isPos = POS_SET.has(t) !== negated;
    (isPos ? pos : neg).push(negated ? `not ${t}` : t);
  }
  const n = pos.length + neg.length;
  return { score: n ? (pos.length - neg.length) / n : 0, pos, neg };
}

// The sign used for counting: good, bad or neither.
export const signOf = (t) => (t.score > 0 ? 1 : t.score < 0 ? -1 : 0);
