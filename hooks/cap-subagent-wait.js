#!/usr/bin/env node
'use strict';

// PreToolUse on Bash, off unless EMBER_SUBAGENT=1. A subagent's foreground Bash call
// that outlives the 5-minute cache forces a full rewrite on the next request, and a
// long declared timeout stops Claude Code from moving the command to the background.
// The timeout is lowered to the cap, so a long command moves there and short commands
// cost nothing. poll-after-move.js takes over after the move.

const { readStdin } = require('./ember-lib');
const config = require('./ember-config');

const DEFAULT_CAP_MS = config.INTERVAL_SEC['5m'] * 1000;

const isTruthy = (value) => value !== undefined && value !== '' && !/^(0|false|no|off)$/i.test(value);

// Returns null where a move cannot happen (background tasks disabled). No permission
// decision is set, so the normal permission check still applies.
function decide(payload, capMs, env = process.env) {
  if (isTruthy(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return null;
  const input = payload.tool_input;
  if (!payload.agent_id || payload.tool_name !== 'Bash' || !input) return null;
  if (input.run_in_background || !(input.timeout > capMs)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, timeout: capMs } } };
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

module.exports = { decide, DEFAULT_CAP_MS };
