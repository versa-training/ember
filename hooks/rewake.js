#!/usr/bin/env node
'use strict';

// Stop hook, run with asyncRewake. Sleeps just under the 1-hour cache lifetime,
// then exits 2 to wake the idle session for one short turn. A newer Stop or a
// user prompt bumps the generation, so a sleeper that is out of date exits quietly.

const { readStdin, intEnv, isOff, readState, writeState, transcriptTail } = require('./warmcache-lib');

const DEFAULT_INTERVAL_SEC = 3540;
const DEFAULT_MAX_WAKES = 4;
const WAKE_MESSAGE =
  'warmcache keepalive: this turn only keeps the prompt cache warm. Reply with the single word ok. Do not use tools.';

const SLICE_MS = 5000;
const STALE_MS = 60000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The cache entry was last refreshed by the newest usage entry, so it expires one
// interval after that. Without a usable timestamp the deadline is one interval from now.
function deadlineFor(newestMs, nowMs, intervalSec) {
  return (Number.isFinite(newestMs) ? newestMs : nowMs) + intervalSec * 1000;
}

// A clock far past the deadline means the machine was suspended: the cache has
// probably expired, and a wake would pay for a full rewrite.
function isStale(nowMs, deadlineMs) {
  return nowMs - deadlineMs > STALE_MS;
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
  if (!state) return 0;
  const { ttl, newestMs } = transcriptTail(payload.transcript_path);
  if (!shouldSleep({ ttl, intervalOverride, wakes: state.wakes, maxWakes })) return 0;

  const generation = state.generation + 1;
  if (!writeState(sessionId, { ...state, generation })) return 0;
  const deadline = deadlineFor(newestMs, Date.now(), intervalOverride ?? DEFAULT_INTERVAL_SEC);
  while (Date.now() < deadline) {
    sleep(Math.min(SLICE_MS, deadline - Date.now()));
    const current = readState(sessionId);
    if (!current || current.generation !== generation) return 0;
  }
  if (isStale(Date.now(), deadline)) return 0;

  const latest = readState(sessionId);
  if (!latest || latest.generation !== generation) return 0;
  if (!writeState(sessionId, { ...latest, wakes: latest.wakes + 1, pendingWakeAt: Date.now() })) return 0;
  process.stderr.write(`${WAKE_MESSAGE}\n`);
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { shouldSleep, deadlineFor, isStale, WAKE_MESSAGE };
