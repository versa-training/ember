#!/usr/bin/env node
'use strict';

// UserPromptSubmit. A real prompt cancels any pending wake and restarts the count.
// A rewake also fires this event, so the prompt right after a wake keeps the count.

const { readStdin, readState, writeState } = require('./warmcache-lib');

const WAKE_GRACE_MS = 30000;

let payload;
try {
  payload = JSON.parse(readStdin());
} catch {
  process.exit(0);
}
if (!payload.session_id || payload.agent_id) process.exit(0);
const state = readState(payload.session_id);
const fromWake = state.pendingWakeAt && Date.now() - state.pendingWakeAt < WAKE_GRACE_MS;
writeState(payload.session_id, {
  generation: state.generation + 1,
  wakes: fromWake ? state.wakes : 0,
});
