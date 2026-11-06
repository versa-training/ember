---
name: wakes
description: Set how many keepalive wakes this session gets. Use when the user says how many wakes they want, for example "6 wakes", "no wakes", "keep this cache warm for 12 hours", or "/ember:wakes".
---

# ember wakes

The count is `$ARGUMENTS`, or the number the user asked for. It applies to this session only and stays until the session ends. The wake count restarts at every prompt, so the limit is the number of wakes between prompts.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/set-wakes.js" <count>
```

- `0` turns wakes off for this session.
- Without a count, the script prints the current limit.
- If the user gives a duration, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-env.js"` to read the wake interval, then divide. On a 1-hour cache a wake comes every 59 minutes, so 12 hours is 12 wakes.

Report the script's output in one line. Do not use this skill for subagents: a hook cannot wake them.
