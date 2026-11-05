#!/usr/bin/env node
'use strict';

// PreToolUse on Bash. A subagent's foreground Bash call that outlives the
// 5-minute cache forces a full rewrite on the next request. The call is denied,
// not shortened: a shorter Bash timeout can kill the running command.

const { readStdin, intEnv, isOff } = require('./ember-lib');

const DEFAULT_CAP_MS = 270000;

const isTruthy = (value) => value !== undefined && value !== '' && !/^(0|false|no|off)$/i.test(value);

// Returns null where the instruction cannot be followed (background tasks disabled)
// or its reason would be false (subagents already use a 1-hour cache). A
// subagentPromptCacheTtl setting of 1h is not visible to hooks: set EMBER_SUBAGENT=0 then.
function decide(payload, capMs, env = process.env) {
  if (isTruthy(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return null;
  if (env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL === '1h') return null;
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
  const output = decide(payload, intEnv('EMBER_SUBAGENT_WAIT_MS', DEFAULT_CAP_MS));
  if (output) process.stdout.write(JSON.stringify(output));
}

module.exports = { decide, DEFAULT_CAP_MS };
