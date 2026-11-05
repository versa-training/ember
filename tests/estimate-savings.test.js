'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { estimate, format, modeRows, longBashIds, countBucket } = require('../scripts/estimate-savings');
const { envLines } = require('../scripts/check-env');

const script = (name) => path.join(__dirname, '..', 'scripts', name);
const T0 = Date.UTC(2026, 0, 1);
const MIN = 60000;

function line(id, minute, usage, content, model = 'claude-sonnet-4-5') {
  return JSON.stringify({ timestamp: new Date(T0 + minute * MIN).toISOString(), message: { id, model, usage, content } });
}
const use = (read, create, ttl = '5m') => ({
  input_tokens: 10, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: create,
  cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? create : 0, ephemeral_1h_input_tokens: ttl === '1h' ? create : 0 },
});
const bash = (timeout) => [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1', timeout } }];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warmcache-est-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, 's', 'subagents'), { recursive: true });
  // Main agent: one 20-minute pause with a 100k context.
  fs.writeFileSync(path.join(project, 's.jsonl'), [
    line('m1', 0, use(0, 100000, '1h')),
    line('m2', 1, use(100000, 500, '1h')),
    line('m3', 21, use(0, 100500, '1h')),
  ].join('\n'));
  // Subagent a: a 10-minute gap after a long foreground Bash call. Subagent b: the same gap with none.
  fs.writeFileSync(path.join(project, 's', 'subagents', 'a.jsonl'), [
    line('a1', 0, use(0, 100000), bash(600000)),
    line('a2', 10, use(0, 100000)),
  ].join('\n'));
  fs.writeFileSync(path.join(project, 's', 'subagents', 'b.jsonl'), [
    line('b1', 0, use(0, 100000), bash(1000)),
    line('b2', 10, use(0, 100000)),
  ].join('\n'));
  return root;
}

test('patterns, costs, and the unreachable share on fixture transcripts', (t) => {
  const result = estimate(fixture(t), 0);
  assert.equal(result.main.agents, 1);
  assert.deepEqual(result.main.agentPauses, [0, 1, 0, 0]);
  assert.deepEqual(result.main.pauseLengths, [0, 1, 0]);
  assert.equal(result.subagent.agents, 2);
  assert.deepEqual(result.subagent.pauseLengths, [0, 2, 0]);
  // The two subagent gaps are equal, and only one follows a long Bash call.
  assert.ok(result.subagent.expiryAll > 0);
  assert.ok(Math.abs(result.subagent.expiryUnreachable / result.subagent.expiryAll - 0.5) < 1e-9);
  // A 20-minute pause: 1 hour is cheaper than 5 minutes, and refreshing a 5-minute cache beats no refresh.
  assert.ok(result.main.sims.no1h < result.main.sims.no5m);
  assert.ok(result.subagent.sims.refresh5m < result.subagent.sims.no5m);
  // Every row is the actual cost minus its saving.
  for (const row of modeRows(result.main, false).slice(1)) assert.ok(Math.abs(row.saving - (result.main.totals.total - row.cost)) < 1e-9);
  assert.equal(modeRows(result.subagent, true).length, 4);
  assert.equal(modeRows(result.main, false).length, 7);
});

test('the text output is labeled simulated and deterministic', (t) => {
  const root = fixture(t);
  const a = format(estimate(root, 0), 0, root, null);
  const b = format(estimate(root, 0), 0, root, null);
  assert.equal(a, b);
  assert.match(a, /SIMULATED/);
  assert.match(a, /1 hour, wake every 59 min, up to 4/);
  assert.match(a, /cannot reach/);
});

test('an empty history and an unpriced model are reported', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'warmcache-est-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const none = spawnSync('node', [script('estimate-savings.js'), '--dir', empty, '--days', '0'], { encoding: 'utf8' });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No transcripts with priced requests/);

  fs.writeFileSync(path.join(empty, 'x.jsonl'), line('u1', 0, use(0, 5000), undefined, 'mystery-model'));
  const unpriced = spawnSync('node', [script('estimate-savings.js'), '--dir', empty, '--days', '0'], { encoding: 'utf8' });
  assert.match(unpriced.stdout, /Skipped requests by model: mystery-model 1/);
});

test('--json prints parseable output and bad flags fail', (t) => {
  const root = fixture(t);
  const ok = spawnSync('node', [script('estimate-savings.js'), '--dir', root, '--days', '0', '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).main.agents, 1);
  assert.equal(spawnSync('node', [script('estimate-savings.js'), '--days', 'x'], { encoding: 'utf8' }).status, 1);
});

test('helpers', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(countBucket), [0, 1, 2, 2, 3, 3]);
  const ids = longBashIds([line('x', 0, use(0, 1), bash(300000)), line('y', 0, use(0, 1), bash(270000))].join('\n'));
  assert.deepEqual([...ids], ['x']);
});

test('check-env leaves secret-looking variables out', () => {
  const { shown, hidden } = envLines({ CLAUDE_CODE_FOO: 'a', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 'y', ANTHROPIC_BASE_URL: 'https://u:p@h/', PATH: '/bin' });
  assert.deepEqual(shown, ['CLAUDE_CODE_FOO=a']);
  assert.deepEqual(hidden.sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MESSAGING_TOKEN']);
});
