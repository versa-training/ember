#!/usr/bin/env node
'use strict';

// Sets how many wakes the current session gets between prompts. The limit is stored
// in the session's state file and wins over EMBER_MAX_WAKES. Without an argument it
// prints the current limit.

const { readState, writeState } = require('../hooks/ember-lib');
const config = require('../hooks/ember-config');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
if (!sessionId) fail('ember: CLAUDE_CODE_SESSION_ID is not set, so the session is unknown');
const state = readState(sessionId);
if (!state) fail('ember: the state directory is not a real directory owned by this user');

const count = process.argv[2];
if (count !== undefined) {
  if (!/^\d+$/.test(count)) fail(`ember: the wake count must be a whole number of 0 or more, got ${count}`);
  if (!writeState(sessionId, { ...state, maxWakes: Number(count) })) fail('ember: the wake count could not be stored');
  process.stdout.write(`ember: this session now gets up to ${Number(count)} wakes between prompts\n`);
} else if (state.maxWakes !== undefined) {
  process.stdout.write(`ember: this session gets up to ${state.maxWakes} wakes between prompts (set for this session)\n`);
} else {
  const { value, source } = config.maxWakes();
  process.stdout.write(`ember: this session gets up to ${value} wakes between prompts (${source})\n`);
}
