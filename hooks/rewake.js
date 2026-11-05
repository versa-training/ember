#!/usr/bin/env node
'use strict';

// Stop hook, run with asyncRewake. Sleeps just under the 1-hour cache lifetime,
// then exits 2 to wake the idle session for one short turn. A newer Stop or a
// user prompt bumps the generation, so a sleeper that is out of date exits quietly.

const { readStdin, intEnv, isOff, readState, writeState, lastCacheTtl } = require('./warmcache-lib');

const DEFAULT_INTERVAL_SEC = 3540;
const DEFAULT_MAX_WAKES = 4;
const WAKE_MESSAGE =
  'warmcache keepalive: this turn only keeps the prompt cache warm. Reply with the single word ok. Do not use tools.';

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function shouldSleep({ ttl, intervalOverride, wakes, maxWakes }) {
  if (wakes >= maxWakes) return false;
  return intervalOverride !== null || ttl === '1h';
}

function main() {
  if (isOff('WARMCACHE_MAIN')) return 0;
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return 0;
  }
  const sessionId = payload.session_id;
  if (!sessionId || payload.agent_id) return 0;

  const intervalOverride = intEnv('WARMCACHE_MAIN_INTERVAL_SEC', null);
  const maxWakes = intEnv('WARMCACHE_MAX_WAKES', DEFAULT_MAX_WAKES);
  const state = readState(sessionId);
  const ttl = lastCacheTtl(payload.transcript_path);
  if (!shouldSleep({ ttl, intervalOverride, wakes: state.wakes, maxWakes })) return 0;

  const generation = state.generation + 1;
  writeState(sessionId, { ...state, generation });
  sleep(intervalOverride ?? DEFAULT_INTERVAL_SEC);

  const latest = readState(sessionId);
  if (latest.generation !== generation) return 0;
  writeState(sessionId, { ...latest, wakes: latest.wakes + 1, pendingWakeAt: Date.now() });
  process.stderr.write(`${WAKE_MESSAGE}\n`);
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { shouldSleep, WAKE_MESSAGE };
