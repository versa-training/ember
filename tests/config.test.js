'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const c = require('../hooks/ember-config');
const { sleepUntilDeadline, isStale } = require('../hooks/rewake');

function project(t, { local, shared, home } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'proj');
  const homeDir = path.join(root, 'home');
  for (const dir of [path.join(cwd, '.claude'), path.join(homeDir, '.claude')]) fs.mkdirSync(dir, { recursive: true });
  const put = (file, value) => value !== undefined && fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  put(path.join(cwd, '.claude', 'settings.local.json'), local);
  put(path.join(cwd, '.claude', 'settings.json'), shared);
  put(path.join(homeDir, '.claude', 'settings.json'), home);
  return { cwd, home: homeDir, managed: path.join(root, 'managed.json') };
}

test('main lifetime: EMBER_MAIN_TTL, then transcript, then env, then settings', (t) => {
  const p = project(t, { home: { promptCacheTtl: '1h' } });
  const all = { EMBER_MAIN_TTL: '5m', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' };
  assert.deepEqual(c.mainLifetime({ env: all, ...p, transcriptTtl: '1h' }), { ttl: '5m', source: 'EMBER_MAIN_TTL' });
  assert.deepEqual(c.mainLifetime({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, ...p, transcriptTtl: '1h' }), { ttl: '1h', source: 'transcript' });
  assert.deepEqual(c.mainLifetime({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, ...p }), { ttl: '5m', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' });
  assert.equal(c.mainLifetime({ env: {}, ...p }).ttl, '1h');
  assert.match(c.mainLifetime({ env: {}, ...p }).source, /promptCacheTtl in .*home/);
  assert.equal(c.mainLifetime({ env: {}, cwd: p.cwd, home: path.join(p.cwd, 'none'), managed: p.managed }).ttl, null);
});

test('invalid values are ignored at every level', (t) => {
  const p = project(t, { home: { promptCacheTtl: '1h' } });
  const env = { EMBER_MAIN_TTL: '2h', CLAUDE_CODE_PROMPT_CACHE_TTL: 'forever' };
  assert.equal(c.mainLifetime({ env, ...p, transcriptTtl: 'x' }).source.startsWith('promptCacheTtl'), true);
});

test('subagent lifetime: EMBER_SUBAGENT_TTL, then env, then settings, then 5m', (t) => {
  const p = project(t, { shared: { subagentPromptCacheTtl: '1h' } });
  assert.deepEqual(c.subagentLifetime({ env: { EMBER_SUBAGENT_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, ...p }), { ttl: '5m', source: 'EMBER_SUBAGENT_TTL' });
  assert.equal(c.subagentLifetime({ env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' }, ...p }).ttl, '5m');
  assert.equal(c.subagentLifetime({ env: {}, ...p }).ttl, '1h');
  assert.deepEqual(c.subagentLifetime({ env: {}, cwd: '/nonexistent-ember', home: '/nonexistent-ember', managed: '/nonexistent-ember/m.json' }), { ttl: '5m', source: 'default' });
});

test('the main lifetime setting does not leak into subagents', (t) => {
  const p = project(t, { local: { promptCacheTtl: '1h' } });
  assert.equal(c.subagentLifetime({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, ...p }).ttl, '5m');
});

test('settings files are read nearest first', (t) => {
  const p = project(t, { local: { promptCacheTtl: '5m' }, shared: { promptCacheTtl: '1h' }, home: { promptCacheTtl: '1h' } });
  assert.equal(c.mainLifetime({ env: {}, ...p }).ttl, '5m');
  const q = project(t, { shared: { promptCacheTtl: '5m' }, home: { promptCacheTtl: '1h' } });
  assert.equal(c.mainLifetime({ env: {}, ...q }).ttl, '5m');
});

test('malformed settings files are skipped and the next file is used', (t) => {
  const p = project(t, { local: '{not json', shared: '[1,2]', home: { promptCacheTtl: '1h', subagentPromptCacheTtl: 'bogus' } });
  assert.equal(c.mainLifetime({ env: {}, ...p }).ttl, '1h');
  assert.equal(c.subagentLifetime({ env: {}, ...p }).ttl, '5m');
  const q = project(t, { local: { promptCacheTtl: 42 }, shared: 'null', home: { promptCacheTtl: '5m' } });
  assert.equal(c.mainLifetime({ env: {}, ...q }).ttl, '5m');
});

test('FORCE_PROMPT_CACHING_5M=1 forces 5m for both agent types over config', (t) => {
  const p = project(t, { local: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' } });
  const env = { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' };
  assert.equal(c.mainLifetime({ env, ...p }).ttl, '5m');
  assert.equal(c.subagentLifetime({ env, ...p }).ttl, '5m');
  assert.equal(c.mainLifetime({ env: { ...env, EMBER_MAIN_TTL: '1h' }, ...p }).ttl, '1h');
  assert.equal(c.mainLifetime({ env: { FORCE_PROMPT_CACHING_5M: '0' }, ...p }).ttl, '1h');
});

test('the transcript outranks configuration for the main agent', (t) => {
  const p = project(t, { local: { promptCacheTtl: '1h' } });
  assert.equal(c.mainLifetime({ env: { FORCE_PROMPT_CACHING_5M: '1' }, ...p, transcriptTtl: '1h' }).ttl, '1h');
  assert.equal(c.configuredMain({ env: {}, ...p }).ttl, '1h');
});

test('env blocks in settings files count, below the process env', (t) => {
  const p = project(t, { local: { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' } } });
  const m = c.mainLifetime({ env: {}, ...p });
  assert.equal(m.ttl, '1h');
  assert.match(m.source, /env block/);
  assert.equal(c.subagentLifetime({ env: {}, ...p }).ttl, '1h');
  assert.equal(c.mainLifetime({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, ...p }).ttl, '5m');
});

test('managed settings outrank project and user settings', (t) => {
  const p = project(t, { local: { promptCacheTtl: '5m' }, home: { promptCacheTtl: '5m' } });
  fs.writeFileSync(p.managed, JSON.stringify({ promptCacheTtl: '1h' }));
  assert.match(c.mainLifetime({ env: {}, ...p }).source, /managed\.json/);
  assert.equal(c.mainLifetime({ env: {}, ...p }).ttl, '1h');
  assert.equal(c.settingsFiles('/x', '/h')[0], '/etc/claude-code/managed-settings.json');
});

test('ENABLE_PROMPT_CACHING_1H=1 asks for one hour for both, below the specific controls', (t) => {
  const p = project(t, { local: { subagentPromptCacheTtl: '5m' } });
  assert.equal(c.mainLifetime({ env: { ENABLE_PROMPT_CACHING_1H: '1' }, ...p }).ttl, '1h');
  assert.equal(c.subagentLifetime({ env: { ENABLE_PROMPT_CACHING_1H: '1' }, ...p }).ttl, '5m');
  const q = project(t, {});
  assert.equal(c.subagentLifetime({ env: { ENABLE_PROMPT_CACHING_1H: '1' }, ...q }).ttl, '1h');
});

test('intervals derive from the lifetime and the overrides are exact', () => {
  assert.equal(c.mainInterval('5m', {}).seconds, 270);
  assert.equal(c.mainInterval('1h', {}).seconds, 3540);
  assert.deepEqual(c.mainInterval('1h', { EMBER_MAIN_INTERVAL_SEC: '7' }), { seconds: 7, source: 'EMBER_MAIN_INTERVAL_SEC' });
  assert.equal(c.mainInterval('1h', { EMBER_MAIN_INTERVAL_SEC: 'x' }).seconds, 3540);
  assert.equal(c.subagentWait('5m', {}).ms, 270000);
  assert.equal(c.subagentWait('1h', {}).ms, 3540000);
  assert.equal(c.subagentWait('1h', { EMBER_SUBAGENT_WAIT_MS: '1000' }).ms, 1000);
});

test('wake limit defaults to 4 and the message can be replaced', () => {
  assert.deepEqual(c.maxWakes({}), { value: 4, source: 'default' });
  assert.equal(c.maxWakes({ EMBER_MAX_WAKES: '3' }).value, 3);
  assert.equal(c.maxWakes({ EMBER_MAX_WAKES: '0' }).value, 0);
  assert.match(c.wakeMessage({}), /^ember keepalive/);
  assert.equal(c.wakeMessage({ EMBER_WAKE_MESSAGE: 'hi' }), 'hi');
});

test('a settings file edited from 5m to 1h while a sleeper sleeps moves its deadline', (t) => {
  const p = project(t, { local: { promptCacheTtl: '5m' } });
  const file = path.join(p.cwd, '.claude', 'settings.local.json');
  let clock = 1000000;
  const deadlines = [];
  const out = sleepUntilDeadline({
    startMs: clock,
    intervalSec: () => c.INTERVAL_SEC[c.configuredMain({ env: {}, ...p }).ttl],
    isCurrent: () => true,
    now: () => clock,
    nap: (ms) => {
      clock += ms;
      if (clock - 1000000 >= 100000 && clock - 1000000 < 105000) fs.writeFileSync(file, JSON.stringify({ promptCacheTtl: '1h' }));
    },
    onDeadline: (at, seconds) => deadlines.push(seconds),
  });
  assert.deepEqual(deadlines, [270, 3540]);
  assert.equal(out.deadline, 1000000 + 3540000);
  assert.equal(clock >= out.deadline, true);
});

test('a change from 1h to 5m after 5 minutes ends the wait at the new deadline, which the stale check rejects', (t) => {
  const p = project(t, { local: { promptCacheTtl: '1h' } });
  const file = path.join(p.cwd, '.claude', 'settings.local.json');
  let clock = 0;
  const out = sleepUntilDeadline({
    startMs: 0,
    intervalSec: () => c.INTERVAL_SEC[c.configuredMain({ env: {}, ...p }).ttl],
    isCurrent: () => true,
    now: () => clock,
    nap: (ms) => { clock += ms; if (clock >= 600000) fs.writeFileSync(file, JSON.stringify({ promptCacheTtl: '5m' })); },
  });
  assert.equal(out.deadline, 270000);
  assert.equal(isStale(clock, out.deadline), true);
});

test('a superseded sleeper stops at once', () => {
  let clock = 0;
  const out = sleepUntilDeadline({ startMs: 0, intervalSec: () => 270, isCurrent: () => false, now: () => clock, nap: (ms) => { clock += ms; } });
  assert.equal(out.current, false);
});
