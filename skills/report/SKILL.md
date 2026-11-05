---
name: report
description: Estimate what expired prompt caches cost in Claude Code, from the local transcripts. Use for "cache report", "what do expired caches cost me", or "/warmcache:report".
---

# warmcache report

Run the report and show its output unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cache-report.js" --days 30
```

`--days 0` reads every transcript and can take minutes on large histories.

Then state in two sentences which line is largest and whether the simulated net saving is positive. Say that the dollar figures are estimates at API list prices, and that the keepalive figures are simulated.
