#!/usr/bin/env node
'use strict';

// PostToolUse on Bash. EMBER_SUBAGENT=0 turns it off. When Claude Code moves a subagent's
// command to the background, a subagent that ends its turn sends no request until the
// finish notification, so its cache can expire. A hook cannot wake a subagent, so this
// tells it to check once: the check that returns leads to a request, which refreshes
// the cache. A check uses no tokens while it waits. The move and one check are two
// refreshes, which covers 95.9% of subagent pauses on the reference workload.

const { readStdin, isOff } = require('./ember-lib');
const config = require('./ember-config');

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
        `Check on it once with a Bash call that sets the timeout parameter to ${seconds * 1000}, using the output file named in the tool result: ` +
        `timeout ${wait} sh -c 'until grep -qE "^\\[(exited with code [0-9]+|killed)\\]" <output file>; do sleep 5; done'; tail -n 20 <output file> ` +
        `If the output file then shows the exit line, continue your task. If not, do not check again: end your turn, and you will be told when the command finishes.`,
    },
  };
}

if (require.main === module) {
  if (isOff('EMBER_SUBAGENT')) process.exit(0);
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }
  const output = decide(payload, config.subagentWait(config.subagentLifetime({ cwd: payload.cwd || process.cwd() }).ttl).ms);
  if (output) process.stdout.write(JSON.stringify(output));
}

module.exports = { decide };
