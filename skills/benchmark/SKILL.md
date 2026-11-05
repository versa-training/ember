---
name: benchmark
description: Estimate savings per cache mode from local history. Use for "what would warmcache save me", "which cache mode fits my usage", or "/warmcache:benchmark".
---

# warmcache savings estimate

Reads local transcripts only. Never start agents or sessions. Scripts do all arithmetic and parsing. Do not compute figures by hand.

1. Run the environment check and show its output unchanged:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-env.js"
   ```

2. Run the estimate and show its output unchanged (`--days 0` reads everything and can take minutes):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/estimate-savings.js" --days 30
   ```

3. In a few sentences, interpret the usage patterns: which pattern the user has (mostly 0 pauses, or many agents with 4 or more), which mode the numbers favor for main agents and for subagents, and the estimated saving against actual. Label every figure simulated at API list prices. Note the share of subagent expiry the hook cannot reach. If the lifetime now is 5 minutes, say so.

Details and limits: `docs/benchmarks.md`.
