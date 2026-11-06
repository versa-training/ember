#!/usr/bin/env node
'use strict';

// PostToolUse on Bash, off unless EMBER_SUBAGENT=1. When Claude Code moves a subagent's
// command to the background, a subagent that ends its turn sends no request until the
// finish notification, so its cache can expire. A hook cannot wake a subagent, so this
// tells it to keep checking: each check that returns leads to a request, which refreshes
// the cache. A check uses no tokens while it waits.

const { readStdin } = require('./ember-lib');
const config = require('./ember-config');

const MAX_CHECKS = 24; // one expiry costs as much as 24 refreshes, see docs/pricing-math.md

function responseOf(payload) {
  const response = payload.tool_response;
  if (typeof response !== 'string') return response;
  try {
    return JSON.parse(response);
  } catch {
    return null;
  }
}

function decide(payload, capMs) {
  const input = payload.tool_input;
  if (!payload.agent_id || payload.tool_name !== 'Bash' || !input || input.run_in_background) return null;
  if (!responseOf(payload)?.backgroundTaskId) return null;
  const seconds = Math.floor(capMs / 1000);
  const wait = Math.max(1, seconds - 30);
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `ember: this command is still running. To keep your prompt cache warm, do not end your turn to wait for it. ` +
        `Check on it with a Bash call that sets the timeout parameter to ${seconds * 1000}, using the output file named in the tool result: ` +
        `timeout ${wait} sh -c 'until grep -qE "^\\[(exited with code [0-9]+|killed)\\]" <output file>; do sleep 5; done'; tail -n 20 <output file> ` +
        `Repeat that call until the output file shows the exit line, then continue your task. After ${MAX_CHECKS} checks, stop checking and end your turn.`,
    },
  };
}

if (require.main === module) {
  if (process.env.EMBER_SUBAGENT !== '1') process.exit(0);
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }
  const output = decide(payload, config.subagentWait(config.subagentLifetime({ cwd: payload.cwd || process.cwd() }).ttl).ms);
  if (output) process.stdout.write(JSON.stringify(output));
}

module.exports = { decide, MAX_CHECKS };
