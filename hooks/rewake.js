#!/usr/bin/env node
'use strict';

// Stop hook, run with asyncRewake. Sleeps just under the 1-hour cache lifetime,
// then exits 2 to wake the idle session for one short turn. A newer Stop or a
// user prompt bumps the generation, so a sleeper that is out of date exits quietly.

const { readStdin, intEnv, isOff, readState, writeState, transcriptTail } = require('./ember-lib');

const DEFAULT_INTERVAL_SEC = 3540;
const DEFAULT_MAX_WAKES = 4;
const WAKE_MESSAGE =
  'ember keepalive: this turn only keeps the prompt cache warm. Reply with the single word ok. Do not use tools.';

const SLICE_MS = 5000;
const STALE_MS = 60000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The transcript at Stop can lack the current turn, so its newest usage entry may
// be an older turn and would give a deadline in the past. The deadline is one
// interval after the hook starts. A final response that streams for more than
// 60 seconds lets the cache expire before the wake.
function deadlineFor(startMs, intervalSec) {
  return startMs + intervalSec * 1000;
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
  if (isOff('EMBER_MAIN')) return 0;
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return 0;
  }
  const sessionId = payload.session_id;
  if (!sessionId || payload.agent_id) return 0;

  const intervalOverride = intEnv('EMBER_MAIN_INTERVAL_SEC', null);
  const maxWakes = intEnv('EMBER_MAX_WAKES', DEFAULT_MAX_WAKES);
  const state = readState(sessionId);
  if (!state) return 0;
  const startMs = Date.now();
  const { ttl } = transcriptTail(payload.transcript_path);
  if (!shouldSleep({ ttl, intervalOverride, wakes: state.wakes, maxWakes })) return 0;

  const generation = state.generation + 1;
  if (!writeState(sessionId, { ...state, generation })) return 0;
  const deadline = deadlineFor(startMs, intervalOverride ?? DEFAULT_INTERVAL_SEC);
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
