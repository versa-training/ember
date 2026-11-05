#!/usr/bin/env node
'use strict';

// Stop hook, run with asyncRewake. Sleeps just under the cache lifetime (5 minutes or 1 hour),
// then exits 2 to wake the idle session for one short turn. A newer Stop or a
// user prompt bumps the generation, so a sleeper that is out of date exits quietly.

const fs = require('node:fs');
const { readStdin, intEnv, isOff, readState, writeState, transcriptTail } = require('./ember-lib');
const config = require('./ember-config');

const WAKE_MESSAGE = config.DEFAULT_WAKE_MESSAGE;

const SLICE_MS = 5000;
const STALE_MS = 60000;
const RESOLVE_MS = 60000;
const TTL_RETRY_MS = 2000;
const TTL_RETRIES = 10;

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
  return intervalOverride !== null || ttl === '1h' || ttl === '5m';
}

// Sleeps until the deadline, which is startMs plus the interval. The interval is
// resolved again every resolveMs and just before the end, so a changed lifetime moves
// the deadline. `intervalSec()` returns the current interval, or null to keep the last
// one. `isCurrent()` returns false when a newer Stop or prompt took over. Returns
// { current, deadline }: the last deadline, and false when superseded.
function sleepUntilDeadline({ startMs, intervalSec, isCurrent, now = Date.now, nap = sleep, sliceMs = SLICE_MS, resolveMs = RESOLVE_MS, onDeadline = () => {} }) {
  let seconds = intervalSec();
  let deadline = deadlineFor(startMs, seconds);
  onDeadline(deadline, seconds);
  let lastResolve = now();
  const resolveAgain = () => {
    lastResolve = now();
    const next = intervalSec();
    if (next !== null && next !== seconds) {
      seconds = next;
      deadline = deadlineFor(startMs, seconds);
      onDeadline(deadline, seconds);
    }
  };
  let settled = false;
  while (!settled) {
    while (now() < deadline) {
      nap(Math.min(sliceMs, deadline - now()));
      if (!isCurrent()) return { current: false, deadline };
      if (now() - lastResolve >= resolveMs) resolveAgain();
    }
    // One more look just before waking.
    const before = deadline;
    resolveAgain();
    settled = deadline === before || deadline <= now();
  }
  return { current: true, deadline };
}

function log(entry) {
  if (!process.env.EMBER_LOG) return;
  try {
    fs.appendFileSync(process.env.EMBER_LOG, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // logging is optional
  }
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
  const maxWakes = config.maxWakes().value;
  const state = readState(sessionId);
  if (!state) return 0;
  const startMs = Date.now();
  const settingsCwd = payload.cwd || process.cwd();
  const explicit = config.explicitMainLifetime();
  let lifetime = explicit;
  let ttl = lifetime ? lifetime.ttl : transcriptTail(payload.transcript_path).ttl;
  // An interactive transcript can lack the current turn at Stop. Wait for it.
  if (ttl === null && intervalOverride === null && state.wakes < maxWakes) {
    const retryMs = intEnv('EMBER_TTL_RETRY_MS', TTL_RETRY_MS);
    const retries = intEnv('EMBER_TTL_RETRIES', TTL_RETRIES);
    for (let i = 0; i < retries && ttl === null; i += 1) {
      sleep(retryMs);
      const current = readState(sessionId);
      if (!current || current.generation !== state.generation) return 0;
      ttl = transcriptTail(payload.transcript_path).ttl;
    }
  }
  if (!lifetime) lifetime = config.mainLifetime({ cwd: settingsCwd, transcriptTtl: ttl });
  ttl = lifetime.ttl;
  if (!shouldSleep({ ttl, intervalOverride, wakes: state.wakes, maxWakes })) return 0;

  const generation = state.generation + 1;
  if (!writeState(sessionId, { ...state, generation })) return 0;
  // The lifetime is resolved again on each pass: settings files are read fresh. The
  // process env is the one this hook started with.
  const resolveSeconds = () => {
    if (intervalOverride !== null) return intervalOverride;
    const fresh = config.mainLifetime({ cwd: settingsCwd, transcriptTtl: explicit ? null : transcriptTail(payload.transcript_path).ttl });
    return fresh.ttl ? config.INTERVAL_SEC[fresh.ttl] : null;
  };
  const first = config.mainInterval(ttl).seconds;
  const interval = () => resolveSeconds() ?? first;
  const outcome = sleepUntilDeadline({
    startMs,
    intervalSec: interval,
    isCurrent: () => {
      const current = readState(sessionId);
      return Boolean(current) && current.generation === generation;
    },
    resolveMs: intEnv('EMBER_RESOLVE_MS', RESOLVE_MS),
    onDeadline: (at, seconds) => log({ event: 'deadline', at: new Date(at).toISOString(), seconds }),
  });
  if (!outcome.current) return 0;
  const { deadline } = outcome;
  if (isStale(Date.now(), deadline)) return 0;

  const latest = readState(sessionId);
  if (!latest || latest.generation !== generation) return 0;
  if (!writeState(sessionId, { ...latest, wakes: latest.wakes + 1, pendingWakeAt: Date.now() })) return 0;
  process.stderr.write(`${config.wakeMessage()}\n`);
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { sleepUntilDeadline, shouldSleep, deadlineFor, isStale, WAKE_MESSAGE };
