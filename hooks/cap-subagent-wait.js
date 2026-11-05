#!/usr/bin/env node
'use strict';

// PreToolUse on Bash. A subagent's foreground Bash call that outlives the
// 5-minute cache forces a full rewrite on the next request. The call is denied,
// not shortened: a shorter Bash timeout can kill the running command.

const { readStdin, isOff } = require('./ember-lib');
const config = require('./ember-config');

const DEFAULT_CAP_MS = config.INTERVAL_SEC['5m'] * 1000;

const isTruthy = (value) => value !== undefined && value !== '' && !/^(0|false|no|off)$/i.test(value);

// Returns null where the instruction cannot be followed (background tasks disabled).
// capMs comes from the subagent lifetime, so with a 1-hour lifetime it is 3540 seconds.
function decide(payload, capMs, env = process.env) {
  if (isTruthy(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return null;
  const input = payload.tool_input;
  if (!payload.agent_id || payload.tool_name !== 'Bash' || !input) return null;
  if (input.run_in_background || !(input.timeout > capMs)) return null;
  const seconds = Math.floor(capMs / 1000);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `ember: a Bash timeout above ${seconds} seconds lets the prompt cache expire. ` +
        `Run this command again with run_in_background: true, then check its output with Bash calls shorter than ${seconds} seconds until it finishes.`,
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

module.exports = { decide, DEFAULT_CAP_MS };
