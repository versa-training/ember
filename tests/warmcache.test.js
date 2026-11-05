'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { decide, DEFAULT_CAP_MS } = require('../hooks/cap-subagent-wait');
const { shouldSleep } = require('../hooks/rewake');
const { lastCacheTtl } = require('../hooks/warmcache-lib');
const { parseTranscript, addTranscript, emptyTotals } = require('../scripts/cache-report');

const hook = (name) => path.join(__dirname, '..', 'hooks', name);
const temporaryDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'warmcache-test-'));
const run = (name, payload, env = {}) =>
  spawnSync('node', [hook(name)], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });

function assistant(id, minute, usage, model = 'claude-opus-5-5') {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
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
  assert.equal(run('cap-subagent-wait.js', payload, { WARMCACHE_SUBAGENT: '0' }).stdout, '');
});

test('sleeps only on a known 1-hour cache and below the wake limit', () => {
  const base = { intervalOverride: null, wakes: 0, maxWakes: 4 };
  assert.equal(shouldSleep({ ...base, ttl: '1h' }), true);
  assert.equal(shouldSleep({ ...base, ttl: '5m' }), false);
  assert.equal(shouldSleep({ ...base, ttl: null }), false);
  assert.equal(shouldSleep({ ...base, ttl: '1h', wakes: 4 }), false);
});

test('rewake exits 2 with the message, then a newer generation cancels it', async () => {
  const dir = temporaryDir();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${assistant('m1', 0, write1h(0, 100))}\n`);
  const env = { WARMCACHE_STATE_DIR: dir, WARMCACHE_MAIN_INTERVAL_SEC: '0' };
  const woken = run('rewake.js', { session_id: 's', transcript_path: transcript }, env);
  assert.equal(woken.status, 2);
  assert.match(woken.stderr, /warmcache keepalive/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).wakes, 1);

  run('reset-on-prompt.js', { session_id: 's' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).wakes, 1, 'the rewake prompt keeps the count');

  run('reset-on-prompt.js', { session_id: 's' }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).wakes, 0, 'a later prompt resets it');

  const limited = run('rewake.js', { session_id: 'other', transcript_path: transcript }, { ...env, WARMCACHE_MAX_WAKES: '0' });
  assert.equal(limited.status, 0);
  assert.equal(limited.stderr, '');
});

test('rewake does nothing for a subagent or when turned off', () => {
  const dir = temporaryDir();
  const env = { WARMCACHE_STATE_DIR: dir, WARMCACHE_MAIN_INTERVAL_SEC: '0' };
  assert.equal(run('rewake.js', { session_id: 's', agent_id: 'a' }, env).status, 0);
  assert.equal(run('rewake.js', { session_id: 's' }, { ...env, WARMCACHE_MAIN: '0' }).status, 0);
});

test('reads the newest cache lifetime from the transcript', () => {
  const dir = temporaryDir();
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
