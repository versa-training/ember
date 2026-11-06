'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { decide, DEFAULT_CAP_MS } = require('../hooks/cap-subagent-wait');
const { shouldSleep, deadlineFor, isStale } = require('../hooks/rewake');
const { lastCacheTtl, transcriptTail } = require('../hooks/ember-lib');
const { parseTranscript, addTranscript, emptyTotals, missRate5m, whatIf, priceFor, analyze, format } = require('../scripts/cache-report');

const hook = (name) => path.join(__dirname, '..', 'hooks', name);
function temporaryDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A developer's own EMBER_* settings must not change what the tests see.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('EMBER_')));
const run = (name, payload, env = {}) =>
  spawnSync('node', [hook(name)], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...cleanEnv, ...env } });

function assistant(id, minute, usage, model = 'claude-opus-5-5', at = Date.UTC(2026, 0, 1, 0, minute)) {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    message: { id, model, usage },
  });
}

const write5m = (read, create) => ({
  cache_read_input_tokens: read,
  cache_creation_input_tokens: create,
  cache_creation: { ephemeral_5m_input_tokens: create, ephemeral_1h_input_tokens: 0 },
});
const write1h = (read, create) => ({
  cache_read_input_tokens: read,
  cache_creation_input_tokens: create,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: create },
});

test('denies a long foreground Bash timeout in a subagent and never shortens it', () => {
  const output = decide({ agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'x', timeout: 590000 } }, DEFAULT_CAP_MS);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /run_in_background: true/);
  assert.equal(output.hookSpecificOutput.updatedInput, undefined);
});

test('leaves the main agent, short waits, and background commands alone', () => {
  const long = { command: 'x', timeout: 590000 };
  assert.equal(decide({ tool_name: 'Bash', tool_input: long }, DEFAULT_CAP_MS), null);
  assert.equal(decide({ agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'x', timeout: 1000 } }, DEFAULT_CAP_MS), null);
  assert.equal(decide({ agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'x' } }, DEFAULT_CAP_MS), null);
  assert.equal(decide({ agent_id: 'a', tool_name: 'Bash', tool_input: { ...long, run_in_background: true } }, DEFAULT_CAP_MS), null);
});

test('the cap hook prints valid hook output and can be turned off', () => {
  const payload = { agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'x', timeout: 590000 } };
  assert.equal(JSON.parse(run('cap-subagent-wait.js', payload).stdout).hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(run('cap-subagent-wait.js', payload, { EMBER_SUBAGENT: '0' }).stdout, '');
});

test('sleeps on a known 5-minute or 1-hour cache and below the wake limit', () => {
  const base = { intervalOverride: null, wakes: 0, maxWakes: 4 };
  assert.equal(shouldSleep({ ...base, ttl: '1h' }), true);
  assert.equal(shouldSleep({ ...base, ttl: '5m' }), true);
  assert.equal(shouldSleep({ ...base, ttl: null }), false);
  assert.equal(shouldSleep({ ...base, ttl: '1h', wakes: 4 }), false);
});

test('rewake exits 2 with the message, then a newer generation cancels it', async (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('m1', 0, write1h(0, 100), undefined, Date.now())}\n`);
  const env = { EMBER_STATE_DIR: dir, EMBER_MAIN_INTERVAL_SEC: '0' };
  const woken = run('rewake.js', { session_id: 's', transcript_path: transcript }, env);
  assert.equal(woken.status, 2);
  assert.match(woken.stderr, /ember keepalive/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).wakes, 1);

  run('reset-on-prompt.js', { session_id: 's' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).wakes, 1, 'the rewake prompt keeps the count');

  run('reset-on-prompt.js', { session_id: 's' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).wakes, 0, 'a later prompt resets it');

  const limited = run('rewake.js', { session_id: 'other', transcript_path: transcript }, { ...env, EMBER_MAX_WAKES: '0' });
  assert.equal(limited.status, 0);
  assert.equal(limited.stderr, '');
});

test('a session wake limit wins over EMBER_MAX_WAKES and survives a prompt', (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('m1', 0, write1h(0, 100), undefined, Date.now())}\n`);
  const env = { EMBER_STATE_DIR: dir, EMBER_MAIN_INTERVAL_SEC: '0', CLAUDE_CODE_SESSION_ID: 's' };
  const setWakes = (...args) => spawnSync('node', [path.join(__dirname, '..', 'scripts', 'set-wakes.js'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const stop = (extra = {}) => run('rewake.js', { session_id: 's', transcript_path: transcript }, { ...env, ...extra });

  assert.match(setWakes().stdout, /up to \d+ wakes/);
  assert.equal(setWakes('1').status, 0);
  assert.match(setWakes().stdout, /up to 1 wakes.*set for this session/);
  assert.equal(stop({ EMBER_MAX_WAKES: '0' }).status, 2, 'the session limit overrides the environment');
  assert.equal(stop({ EMBER_MAX_WAKES: '9' }).status, 0, 'the session limit is reached');

  run('reset-on-prompt.js', { session_id: 's' }, env);
  run('reset-on-prompt.js', { session_id: 's' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).maxWakes, 1);
  assert.equal(stop().status, 2, 'a prompt restarts the count under the same limit');

  assert.equal(setWakes('0').status, 0);
  assert.equal(stop().status, 0);
  assert.equal(setWakes('-1').status, 1);
  assert.equal(setWakes('many').status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).maxWakes, 0);
});

test('rewake does nothing for a subagent or when turned off', (t) => {
  const dir = temporaryDir(t);
  const env = { EMBER_STATE_DIR: dir, EMBER_MAIN_INTERVAL_SEC: '0' };
  assert.equal(run('rewake.js', { session_id: 's', agent_id: 'a' }, env).status, 0);
  assert.equal(run('rewake.js', { session_id: 's' }, { ...env, EMBER_MAIN: '0' }).status, 0);
});

test('reads the newest cache lifetime from the transcript', (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('a', 0, write1h(0, 10))}\n${assistant('b', 1, write5m(10, 5))}\nnot json\n`);
  assert.equal(lastCacheTtl(transcript), '5m');
  assert.equal(lastCacheTtl(path.join(dir, 'missing.jsonl')), null);
});

test('prices a subagent cache expiry and its keepalive', () => {
  const totals = emptyTotals();
  const text = [assistant('a', 0, write5m(0, 100000)), assistant('b', 10, write5m(0, 100000))].join('\n');
  addTranscript(totals, parseTranscript(text), true, new Set());
  assert.equal(totals.misses, 1);
  assert.equal(totals.rewritten, 100000);
  assert.ok(Math.abs(totals.expiry - 100000 * (5 - 0.2) / 1e6) < 1e-9);
  assert.equal(totals.wakes, 2);
  assert.equal(totals.avoided, totals.expiry);
});

test('a wait that kept the cache is not an expiry', () => {
  const totals = emptyTotals();
  const text = [assistant('a', 0, write5m(0, 100000)), assistant('b', 10, write5m(100000, 50))].join('\n');
  addTranscript(totals, parseTranscript(text), true, new Set());
  assert.equal(totals.misses, 0);
  assert.equal(totals.expiry, 0);
});

test('counts a request seen in two transcripts once and keeps the last usage', () => {
  const totals = emptyTotals();
  const seen = new Set();
  const line = assistant('a', 0, write5m(0, 100));
  const updated = assistant('a', 0, write5m(0, 200));
  addTranscript(totals, parseTranscript(`${line}\n${updated}`), false, seen);
  addTranscript(totals, parseTranscript(updated), false, seen);
  assert.equal(totals.requests, 1);
  assert.ok(Math.abs(totals.total - 200 * 5 / 1e6) < 1e-12);
});

test('skips models without a listed price', () => {
  const totals = emptyTotals();
  addTranscript(totals, parseTranscript(assistant('a', 0, write5m(0, 100), 'other-model')), false, new Set());
  assert.equal(totals.requests, 0);
});

test('5-minute what-if applies the measured miss rate as an expected value', () => {
  const expected = [[5, 0.119], [5.4, 0.119], [5.5, 0.775], [6, 0.865], [7, 0.991], [8, 0.993], [10, 0.995], [90, 0.995]];
  for (const [gap, rate] of expected) assert.equal(missRate5m(gap), rate);
  const price = { read: 0.2, write5m: 5, write1h: 8 };
  const use = { read: 100000, create: 1000 };
  const miss = (101000 * 5) / 1e6;
  const hit = (100000 * 0.2 + 1000 * 5) / 1e6;
  const cost = whatIf(price, use, 6.5, 100000, '5m');
  assert.ok(Math.abs(cost - (0.865 * miss + 0.135 * hit)) < 1e-12);
  assert.ok(Math.abs(whatIf(price, use, 2, 100000, '5m') - hit) < 1e-12);
});

test('the cap hook stands down when background tasks are disabled or the timeout is under the 1-hour interval', () => {
  const payload = { agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'x', timeout: 590000 } };
  assert.equal(decide(payload, DEFAULT_CAP_MS, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }), null);
  assert.equal(decide(payload, DEFAULT_CAP_MS, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: 'true' }), null);
  assert.equal(decide(payload, 3540000, {}), null);
  assert.notEqual(decide(payload, DEFAULT_CAP_MS, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' }), null);
});

test('a symlinked state directory is refused and nothing is written through it', (t) => {
  const dir = temporaryDir(t);
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  const link = path.join(dir, 'link');
  fs.symlinkSync(target, link);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('m1', 0, write1h(0, 100), undefined, Date.now())}\n`);
  const env = { EMBER_STATE_DIR: link, EMBER_MAIN_INTERVAL_SEC: '0' };
  const result = run('rewake.js', { session_id: 's', transcript_path: transcript }, env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('the state directory is created with mode 0700', (t) => {
  const dir = path.join(temporaryDir(t), 'state');
  run('reset-on-prompt.js', { session_id: 's' }, { EMBER_STATE_DIR: dir });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), ['s.json']);
});

test('invalid stored state resets to defaults', (t) => {
  const dir = temporaryDir(t);
  const env = { EMBER_STATE_DIR: dir };
  for (const bad of ['{"generation":1,"wakes":-3}', '{"generation":1.5,"wakes":0}', '{"generation":"1","wakes":0}', 'null', 'nope']) {
    fs.writeFileSync(path.join(dir, 's.json'), bad);
    run('reset-on-prompt.js', { session_id: 's' }, env);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8'));
    assert.deepEqual(stored, { generation: 1, wakes: 0 }, bad);
  }
});

test('a superseded sleeper exits within seconds', (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('m1', 0, write1h(0, 100), undefined, Date.now())}\n`);
  const env = { ...process.env, EMBER_STATE_DIR: dir, EMBER_MAIN_INTERVAL_SEC: '600' };
  const started = Date.now();
  const child = require('node:child_process').spawn('node', [hook('rewake.js')], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify({ session_id: 's', transcript_path: transcript }));
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 15000);
      resolve();
    });
    setTimeout(() => run('reset-on-prompt.js', { session_id: 's' }, env), 1500);
  });
});

test('the deadline is one interval after the hook starts, and a late clock means no wake', (t) => {
  assert.equal(deadlineFor(5000, 10), 15000);
  assert.equal(isStale(11000 + 60000, 11000), false);
  assert.equal(isStale(11000 + 60001, 11000), true);

  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('a', 0, write1h(0, 10), undefined, 1000)}\n${assistant('b', 0, write1h(10, 5), undefined, 5000)}\n`);
  assert.equal(transcriptTail(transcript).newestMs, 5000);
});

test('an old newest usage entry does not bring the wake forward', (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('a', 0, write1h(0, 10), undefined, Date.now() - 600000)}\n`);
  const env = { EMBER_STATE_DIR: dir, EMBER_MAIN_INTERVAL_SEC: '3' };
  const started = Date.now();
  const woken = run('rewake.js', { session_id: 's', transcript_path: transcript }, env);
  assert.equal(woken.status, 2);
  assert.ok(Date.now() - started >= 2900, `woke after ${Date.now() - started} ms`);
});

test('prices every listed model, longest id first, and tiers Haiku 5.5 by prompt length', () => {
  assert.equal(priceFor('claude-opus-5-5-20260101').read, 0.2);
  assert.equal(priceFor('claude-opus-5').read, 0.5);
  assert.equal(priceFor('claude-opus-4-5-20251101').input, 5);
  assert.equal(priceFor('claude-opus-4-1').input, 15);
  assert.equal(priceFor('claude-sonnet-4-5').input, 3);
  assert.equal(priceFor('claude-sonnet-5').read, 0.2);
  assert.equal(priceFor('claude-fable-5-1').read, 0.25);
  assert.equal(priceFor('claude-3-5-haiku-20241022').input, 0.8);
  assert.equal(priceFor('claude-haiku-5-5', 100000).input, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', 100001).input, 0.5);
  assert.equal(priceFor('mystery'), null);

  const totals = emptyTotals();
  const text = [
    assistant('a', 0, { input_tokens: 1000, output_tokens: 0 }, 'claude-haiku-5-5'),
    assistant('b', 1, { input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: 0 }, 'claude-haiku-5-5'),
    assistant('c', 2, write5m(0, 10), 'mystery'),
    assistant('d', 3, write5m(0, 10), 'mystery'),
  ].join('\n');
  addTranscript(totals, parseTranscript(text), false, new Set());
  assert.ok(Math.abs(totals.total - (1000 * 0.1 + 1000 * 0.5 + 100000 * 0.05) / 1e6) < 1e-12);
  assert.deepEqual(totals.skipped, { mystery: 2 });
});

test('main-agent wakes are simulated on a 5-minute cache, up to the wake limit', () => {
  const totals = emptyTotals();
  const text = [assistant('a', 0, write5m(0, 100000)), assistant('b', 20, write5m(0, 100000))].join('\n');
  addTranscript(totals, parseTranscript(text), false, new Set());
  assert.equal(totals.misses, 1);
  assert.ok(totals.expiry > 0);
  assert.equal(totals.wakes, 4);
  assert.ok(totals.wakeCost > 0);
  assert.equal(totals.avoided, totals.expiry);
  assert.ok(totals.abandonedWakeCost > 0);
});

test('the 5-minute simulation reports the extra cost of expiries', () => {
  const totals = emptyTotals();
  const text = [assistant('a', 0, write5m(0, 100000)), assistant('b', 30, write5m(100000, 50))].join('\n');
  addTranscript(totals, parseTranscript(text), false, new Set());
  const extra = totals.totalAt5m - totals.noExpiryAt5m;
  assert.ok(extra > 0);
  assert.ok(Math.abs(extra - 0.995 * 100000 * (5 - 0.2) / 1e6) < 1e-6);
  const empty = { main: totals, subagent: emptyTotals() };
  assert.match(format(empty, 0), /Extra cost of expiries[\s\S]*Share of that total/);
});

test('a missing cache_creation breakdown is priced at the lifetime of the agent', () => {
  const flat = (create) => ({ cache_read_input_tokens: 0, cache_creation_input_tokens: create });
  const sub = emptyTotals();
  addTranscript(sub, parseTranscript(assistant('a', 0, flat(1000000))), true, new Set());
  assert.ok(Math.abs(sub.total - 5) < 1e-9);
  const main = emptyTotals();
  addTranscript(main, parseTranscript(assistant('a', 0, flat(1000000))), false, new Set());
  assert.ok(Math.abs(main.total - 8) < 1e-9);
});

test('the report skips dangling symlinks and filters requests by time', (t) => {
  const root = temporaryDir(t);
  fs.symlinkSync(path.join(root, 'nowhere.jsonl'), path.join(root, 'dangling.jsonl'));
  const recent = Date.now() - 3600000;
  const old = Date.now() - 40 * 86400000;
  fs.writeFileSync(path.join(root, 'a.jsonl'), [assistant('a', 0, write5m(0, 100), undefined, old), assistant('b', 0, write5m(0, 100), undefined, recent)].join('\n'));
  assert.equal(analyze(root, 0).main.requests, 2);
  assert.equal(analyze(root, Date.now() - 30 * 86400000).main.requests, 1);
});

test('rewake waits for a transcript that gains its usage entry after Stop', async (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const env = { ...process.env, EMBER_STATE_DIR: dir, EMBER_TTL_RETRY_MS: '100', EMBER_TTL_RETRIES: '50' };
  delete env.EMBER_MAIN_INTERVAL_SEC;
  run('reset-on-prompt.js', { session_id: 's' }, env);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).generation;
  const child = require('node:child_process').spawn('node', [hook('rewake.js')], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => child.kill());
  child.stdin.end(JSON.stringify({ session_id: 's', transcript_path: transcript }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).generation, before, 'still waiting');
  fs.writeFileSync(transcript, `${assistant('m1', 0, write1h(0, 100), undefined, Date.now())}\n`);
  let after = before;
  for (let i = 0; i < 40 && after === before; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    after = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).generation;
  }
  assert.equal(after, before + 1, 'a sleeper started once the lifetime was known');
});

test('rewake gives up and exits 0 when the usage entry never arrives', (t) => {
  const dir = temporaryDir(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const env = { EMBER_STATE_DIR: dir, EMBER_TTL_RETRY_MS: '50', EMBER_TTL_RETRIES: '4', EMBER_MAIN_INTERVAL_SEC: '' };
  run('reset-on-prompt.js', { session_id: 's' }, env);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).generation;
  const started = Date.now();
  const result = run('rewake.js', { session_id: 's', transcript_path: transcript }, env);
  assert.equal(result.status, 0);
  assert.ok(Date.now() - started >= 200, 'waited the retries');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).generation, before);
});
