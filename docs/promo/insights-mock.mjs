// The Insights page of the Tinylink demo with sample data, for docs/promo/screenshots/05-insights*.png.
// In a headless browser, the five Insights RPCs (insights.project/day/digest/tokens, workflow-insights.get) are
// answered with a year of sample activity, a day summary, skill drafts and Workflow numbers; every other frame between
// the page and the daemon passes through. Nothing is written to the project or plugin data. Card titles come from the
// six real Tinylink cards. Usage: node docs/promo/insights-mock.mjs [out.png] [light|dark]
import { launch, open, shot } from './shot-lib.mjs';
const OUT = process.argv[2] || new URL('./screenshots/05-insights.png', import.meta.url).pathname;
const SCHEME = process.argv[3] || 'light';
const PROJECT = '3db2ad5b-e6c4-4054-b2ed-a13a8dfa0663';
const CARDS = {
  rate: '918e5a87-c6b8-45b5-a11c-326bd5c2957c', expired: 'f0e55983-8064-4c1c-9319-a9de794ffe4d', stats: 'af077ae5-9a44-47da-9ede-80dd7964669e',
  alias: '0e9cf956-03cc-4549-8dfe-f9175ad6268f', docker: 'ed8b1a84-40a9-47a3-9fcb-efc9d5c98d54', scaffold: 'eabc3d51-508e-4c1d-b10f-37b0d95c1d79',
};
const ids = Object.values(CARDS);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const today = fmt(new Date(Date.now() + 8 * 3600e3)); // Asia/Singapore
const monday = (day) => { const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); return addDays(day, -((dow + 6) % 7)); };
const from = addDays(monday(today), -7 * 52);
// Deterministic pseudo-random.
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const days = [];
for (let d = from; d <= today; d = addDays(d, 1)) {
  const age = (Date.parse(today) - Date.parse(d)) / 864e5; // 0..370
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const ramp = age > 300 ? 0.15 : age > 200 ? 0.45 : age > 90 ? 0.7 : 0.92;
  if (rnd() > ramp * (weekend ? 0.35 : 1)) continue;
  const turns = Math.max(1, Math.round((weekend ? 3 : 8) * (1.2 - age / 400) * (0.4 + rnd() * 1.6)));
  const cards = Math.max(1, Math.min(6, Math.round(turns / 3 + rnd())));
  const done = rnd() < 0.35 ? [ids[Math.floor(rnd() * ids.length)]] : [];
  days.push({ day: d, turns, cards, done });
}
// The selected day: the busiest of the last 10 days.
const recent = days.filter((x) => x.day > addDays(today, -10) && x.day < today);
const picked = recent.sort((a, b) => b.turns - a.turns)[0];
const counts = days.map((x) => x.turns).sort((a, b) => a - b);
const at = (q) => counts[Math.min(counts.length - 1, Math.ceil(q * counts.length) - 1)];
const levels = []; for (const q of [0.25, 0.5, 0.75]) { const s = at(q) + 1; if (s <= counts.at(-1) && (!levels.length || s > levels.at(-1))) levels.push(s); }
const H = 3600e3, now = Date.now();
const finished = [
  [CARDS.rate, 30, 4], [CARDS.stats, 52, 6], [CARDS.scaffold, 80, 3], [CARDS.docker, 100, 2], [CARDS.alias, 120, 9], [CARDS.expired, 140, 5],
].map(([taskId, ago, dur]) => ({ taskId, start: now - (ago + dur) * H, finishedAt: now - ago * H }));
const projectView = {
  today,
  activity: { from, days: days.slice().sort((a, b) => a.day.localeCompare(b.day)), levels },
  workflow: {
    finished: 9, rounds: 1, onePassShare: 0.44, window: { from: addDays(today, -6), to: today },
    models: [
      { model: 'claude/claude-opus-5-5', finished: 5, rounds: 1, onePassShare: 0.4 },
      { model: 'claude/claude-sonnet-5-5', finished: 4, rounds: 0.5, onePassShare: 0.5 },
    ],
    cards: finished,
  },
};
const tokensView = { perCard: 1840000, models: [{ model: 'claude/claude-opus-5-5', perCard: 2310000 }, { model: 'claude/claude-sonnet-5-5', perCard: 1260000 }], sessions: 14, missing: 0 };
function dayView(day) {
  const a = days.find((x) => x.day === day);
  if (!a) return { day, turns: 0, list: [] };
  const n = Math.min(a.cards, ids.length);
  const weights = [1, 0.62, 0.41, 0.28, 0.18, 0.1].slice(0, n);
  const sum = weights.reduce((s, w) => s + w, 0);
  const list = weights.map((w, i) => {
    const turns = Math.max(1, Math.round((a.turns * w) / sum));
    return { taskId: ids[(i + day.charCodeAt(9)) % ids.length], turns, agentMs: Math.round(turns * (7 + 5 * w) * 60e3), tokens: Math.round(turns * (180e3 + 260e3 * w)), done: a.done.includes(ids[(i + day.charCodeAt(9)) % ids.length]) || (i === 0 && a.turns > 10) };
  });
  return { day, turns: a.turns, agentMs: list.reduce((s, c) => s + c.agentMs, 0), tokens: list.reduce((s, c) => s + c.tokens, 0), list };
}
function digestView(day) {
  if (!days.find((x) => x.day === day)) return { entry: null, running: false, error: null, enabled: true, empty: true };
  return {
    entry: {
      headline: 'Rate limiting shipped after one review round; the expired-link fix is waiting on your 410-vs-404 call.',
      done: [{ text: 'Rate limiting merged with Retry-After and 13 passing tests', taskId: CARDS.rate }],
      progressed: [{ text: 'Click counter endpoint implemented; stats tests in progress', taskId: CARDS.stats }],
      issues: [{ text: 'Expired links still hang the request until a status code is chosen', taskId: CARDS.expired }],
      next: [{ text: 'Answer the 410 Gone vs 404 question on the expired-links card', taskId: CARDS.expired }],
      projectId: PROJECT, day, tz: 'Asia/Singapore', at: new Date(now - 25 * 60e3).toISOString(), model: 'claude/claude-haiku-5-5',
    },
    running: false, error: null, enabled: true, empty: false,
  };
}
const iso = (ms) => new Date(ms).toISOString();
const workflowView = {
  enabled: true, projectEnabled: true, backfilling: false, running: false, nextRunAt: iso(now + 4 * 864e5), windowDays: 7,
  lastRun: { id: 'mock-run', projectId: PROJECT, at: iso(now - 2 * H), from: iso(now - 7 * 864e5 - 2 * H), to: iso(now - 2 * H), model: 'claude/claude-sonnet-5-5', manual: false, status: 'ok',
    usage: { inputTokens: 4210, cachedInputTokens: 96200, outputTokens: 5840, totalCostUsd: 0.31, contextTokens: 118400 }, findings: 3, replaced: 1, stats: { calls: 212, actions: 64, cards: 6, sessions: 9 } },
  findings: [
    { id: 'f1', projectId: PROJECT, runId: 'mock-run', fingerprint: 'skill:ship-pr', target: 'skill', title: 'Ship a change through a pull request',
      evidence: 'On 4 of 6 cards the agent opened a PR, then merged before the review bot replied, and twice forgot to register the PR on the card.',
      proposal: 'Add a ship-pr skill: branch from origin/main, run npm test, open the PR, wait for CI and the review, resolve threads, then merge.', benefit: 'Every card ships the same way, with the review actually read.',
      confidence: 'high', cards: [CARDS.rate, CARDS.stats, CARDS.alias, CARDS.docker], status: 'open',
      skill: { name: 'ship-pr', description: 'Ship a change through a pull request: tests, CI, review threads, merge.', body: '# Ship a change\n\n1. Branch from origin/main.\n2. Run `npm test`.\n3. Open the PR and register it on the card.\n4. Wait for CI and the review; resolve every thread.\n5. Merge with squash.' },
      createdAt: iso(now - 2 * H), updatedAt: iso(now - 2 * H) },
    { id: 'f2', projectId: PROJECT, runId: 'mock-run', fingerprint: 'skill:http-error-tests', target: 'skill', title: 'Cover every HTTP error path with a regression test',
      evidence: 'Three cards fixed a crash in a request handler; each time the user asked for a regression test in a second round.',
      proposal: 'Add an http-error-tests skill that writes a failing test for the status code first, then the fix.', benefit: 'Fewer review rounds on bug-fix cards.',
      confidence: 'medium', cards: [CARDS.expired, CARDS.rate, CARDS.stats], status: 'open',
      skill: { name: 'http-error-tests', description: 'Write the failing status-code test before fixing a request handler.', body: '# HTTP error paths\n\nStart every handler fix with a test that expects the right status code.' },
      createdAt: iso(now - 2 * H), updatedAt: iso(now - 2 * H) },
    { id: 'f3', projectId: PROJECT, runId: 'mock-run', fingerprint: 'paseo_script:test-watch', target: 'paseo_script', title: 'Add a test:watch script to paseo.json',
      evidence: 'Agents ran `node --test --watch` by hand 31 times across 5 sessions.', proposal: 'Add "test:watch": "node --test --watch" to paseo.json scripts.', benefit: 'One command agents can find in their task context.',
      confidence: 'medium', cards: [CARDS.rate, CARDS.alias], status: 'open', createdAt: iso(now - 2 * H), updatedAt: iso(now - 2 * H) },
  ],
  installed: [{ name: 'node-test', path: '.agents/skills/node-test/SKILL.md', content: '---\nname: node-test\ndescription: Run and extend the node:test suite.\n---\n' }],
  current: {}, revision: 46,
};
const answers = {
  'insights.project': () => ({ etag: `mock-${today}`, value: projectView }),
  'insights.tokens': () => ({ etag: `mock-t-${today}`, value: tokensView }),
  'insights.day': (input) => dayView(input.day),
  'insights.digest': (input) => digestView(input.day),
  'workflow-insights.get': () => ({ etag: 'mock-w', value: workflowView }),
};

const browser = await launch();
const s = await open(browser, { w: 1700, h: 1260, scheme: SCHEME });
let mocked = 0;
await s.context.routeWebSocket(/localhost:6767\/ws/, (ws) => {
  const server = ws.connectToServer();
  ws.onMessage((raw) => {
    try {
      const m = JSON.parse(String(raw));
      const msg = m.message;
      if (msg?.type === 'plugin.rpc.invoke.request' && msg.pluginId === 'flowly' && answers[msg.method] && (!msg.input?.projectId || msg.input.projectId === PROJECT)) {
        mocked++;
        ws.send(JSON.stringify({ type: 'session', message: { type: 'plugin.rpc.invoke.response', payload: { requestId: msg.requestId, output: answers[msg.method](msg.input || {}) } } }));
        return;
      }
    } catch {}
    server.send(raw);
  });
  server.onMessage((raw) => ws.send(raw));
});
await s.page.reload({ waitUntil: 'networkidle' });
await s.page.getByText('Flowly', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
await s.page.getByText('Tinylink', { exact: true }).filter({ visible: true }).first().click({ timeout: 8000 }).catch(() => {});
await s.page.getByRole('button', { name: /Open task/ }).first().waitFor();
await s.page.waitForTimeout(2000);
await s.page.getByRole('button', { name: /Project insights/ }).first().click();
await s.page.waitForTimeout(3000);
const label = new Date(`${picked.day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
await s.page.getByRole('button', { name: new RegExp(`^${label}, `) }).filter({ visible: true }).first().click().catch((e) => console.log('pick failed', String(e).slice(0, 120)));
await s.page.waitForTimeout(3000);
await shot(s, OUT);
console.log(JSON.stringify({ mocked, picked: picked.day, days: days.length, errors: s.errors }));
await browser.close();
