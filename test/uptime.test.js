import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseStatusFeed, statuspageUpdates, incidentIoUpdates, saveIncidents, severityOf, SERVICES } from '../src/sources/uptime.js';
import { computeUptime, OUTAGE_RE } from '../src/index/uptime.js';

const svc = (k) => SERVICES.find((s) => s.key === k);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STATUSPAGE = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Claude Status</title>
<entry><id>tag:status.claude.com,2005:Incident/1</id><published>2026-10-22T08:07:03Z</published><updated>2026-10-22T08:07:03Z</updated>
<link rel="alternate" type="text/html" href="https://status.claude.com/incidents/abc"/><title>Elevated errors on claude.ai</title>
<content type="html">${esc(`<p><small>Oct <var data-var='date'>22</var>, <var data-var='time'>08:07</var> UTC</small><br><strong>Resolved</strong> - This incident has been resolved.</p><p><small>Oct <var data-var='date'>22</var>, <var data-var='time'>07:28</var> UTC</small><br><strong>Monitoring</strong> - A fix has been deployed.</p><p><small>Oct <var data-var='date'>22</var>, <var data-var='time'>06:50</var> UTC</small><br><strong>Investigating</strong> - We are investigating elevated errors.</p>`)}</content></entry>
<entry><id>tag:status.claude.com,2005:Incident/2</id><published>2026-10-23T01:00:00Z</published><updated>2026-10-23T01:00:00Z</updated>
<link rel="alternate" type="text/html" href="https://status.claude.com/incidents/def"/><title>claude.ai unavailable</title>
<content type="html">${esc(`<p><small>Oct <var data-var='date'>23</var>, <var data-var='time'>01:00</var> UTC</small><br><strong>Investigating</strong> - claude.ai is unavailable for some users.</p>`)}</content></entry>
</feed>`;

const INCIDENTIO = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>OpenAI</title>
<entry><title type="html"><![CDATA[Degraded performance in ChatGPT]]></title><id>https://status.openai.com//incidents/01M5JHVJVC8WAXB4WRYFMKG6HP</id>
<link href="https://status.openai.com//incidents/01M5JHVJVC8WAXB4WRYFMKG6HP"/><updated>2026-10-21T10:00:00.000Z</updated>
<content type="html"><![CDATA[<b>Status: Resolved</b><br/><br/>All impacted services have now fully recovered.<br/><br/><b>Affected components</b><ul><li>Conversations (Operational)</li><li>Login (Operational)</li></ul>]]></content></entry>
</feed>`;

const INSTATUS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Status updates | Hugging Face</title>
<item><title>Slower downloads</title><link>https://status.huggingface.co/incident/9</link><pubDate>Fri, 25 Sep 2026 18:42:00 -0000</pubDate><category>Incident</category><description>The issue has been resolved and downloads are back to normal.</description></item>
<item><title>Slower downloads</title><link>https://status.huggingface.co/incident/9</link><pubDate>Fri, 25 Sep 2026 12:00:00 -0000</pubDate><category>Incident</category><description>We are seeing slower downloads.</description></item>
<item><title>Maintenance: Inference Endpoints</title><link>https://status.huggingface.co/maintenance/10</link><pubDate>Wed, 07 Oct 2026 12:30:39 -0000</pubDate><category>Maintenance</category><description>Maintenance completed</description></item>
</channel></rss>`;

test('status feeds: Statuspage updates with times, incident.io latest status, Instatus items grouped', () => {
  const [a, b] = parseStatusFeed(STATUSPAGE, svc('claude'));
  assert.equal(a.title, 'Elevated errors on claude.ai');
  assert.deepEqual(a.updates.map((u) => [new Date(u.at).toISOString().slice(11, 16), u.status]), [['06:50', 'investigating'], ['07:28', 'monitoring'], ['08:07', 'resolved']]);
  assert.equal(a.severity, 'minor');
  assert.equal(b.severity, 'major', '"unavailable" is a major outage');

  const [o] = parseStatusFeed(INCIDENTIO, svc('openai'));
  assert.equal(o.key, 'https://status.openai.com/incidents/01M5JHVJVC8WAXB4WRYFMKG6HP', 'doubled slash removed');
  assert.deepEqual(o.updates.map((u) => u.status), ['resolved']);
  assert.deepEqual(o.components, ['Conversations', 'Login']);

  const hf = parseStatusFeed(INSTATUS, svc('huggingface'));
  assert.equal(hf.length, 2);
  assert.deepEqual(hf[0].updates.map((u) => u.status), ['update', 'resolved']);
  assert.equal(hf[1].kind, 'maintenance');

  // An incident over New Year: December updates in a January entry.
  const ny = statuspageUpdates(`<small>Dec <var data-var='date'>31</var>, <var data-var='time'>23:50</var> UTC</small><br><strong>Investigating</strong> - x`, Date.parse('2027-01-01T01:00:00Z'));
  assert.equal(new Date(ny[0].at).toISOString(), '2026-12-31T23:50:00.000Z');
  assert.equal(severityOf('Scheduled maintenance for the API'), 'maintenance');

  const page = String.raw`{\"published_at\":\"2026-10-22T19:36:53.868Z\",\"to_status\":\"identified\"},{\"message\":\"x\",\"published_at\":\"2026-10-23T00:07:55.323Z\",\"to_status\":\"resolved\"}`;
  assert.deepEqual(incidentIoUpdates(page).map((u) => u.status), ['identified', 'resolved']);
});

test('outage headlines: states of being down, not phrasal verbs', () => {
  for (const t of ['ChatGPT is down for thousands of users', 'Claude outage hits developers', 'ChatGPT, Claude and Grok suddenly go down', 'Is Claude down?']) assert.ok(OUTAGE_RE.test(t), t);
  for (const t of ['5 routines where ChatGPT beats Gemini, hands-down', 'Cursor alternative that works offline']) assert.ok(!OUTAGE_RE.test(t), t);
});

test('status board: merged polls, open incidents, day strip, durations and coverage', () => {
  resetDb();
  const now = Date.parse('2026-10-23T02:00:00Z');
  const incs = parseStatusFeed(STATUSPAGE, svc('claude'));
  assert.equal(saveIncidents(incs, now), 2);
  // A second poll with the same feed adds nothing new.
  assert.equal(saveIncidents(parseStatusFeed(STATUSPAGE, svc('claude')), now + 600e3), 0);
  upsertDoc({ url: 'https://x.com/a/status/1', type: 'post', title: 'Is Claude down? claude.ai is not working for me', description: '', body: '', site: 'x.com', source: 'X', published_at: Date.parse('2026-10-22T06:40:00Z') });
  upsertDoc({ url: 'https://news.example/b', type: 'article', title: 'Anthropic says it will slow AI down', description: '', body: '', site: 'news.example', source: 'News', published_at: Date.parse('2026-10-22T07:00:00Z') });
  const d = computeUptime(getDb(), now);
  const claude = d.services.find((s) => s.key === 'claude');
  assert.equal(claude.state, 'major', 'the unresolved "unavailable" incident is open');
  assert.equal(d.services[0].key, 'claude', 'services with open incidents come first');
  assert.equal(claude.days.length, 90);
  assert.equal(claude.days.at(-1).sev, 2);
  assert.equal(claude.days.at(-2).sev, 1);
  const done = d.incidents.find((i) => i.title === 'Elevated errors on claude.ai');
  assert.equal(done.durMin, 77);
  assert.equal(done.news.n, 1, 'only the outage post, not "slow AI down"');
  assert.equal(done.news.leadMin, -10, 'the X post came ten minutes before the status page');
  assert.equal(d.incidents[0].open, true);
  assert.equal(d.stats.noticedFirst, 1);
});
