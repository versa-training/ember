# Changelog

## 0.1.4

- `estimate-savings.js` priced the "1 hour, wake every 59 min" row with the 5-minute write price on every request that had no pause, so the row came out about $265 too low on the measured data and disagreed with `cache-report.js`. `whatIf` now prices `hit1h` at the 1-hour write price.
- `cache-report.js` and `estimate-savings.js` share one wake simulation, `wakePlan`: the wakes sent are capped at the limit, and a gap is covered only when the limit reaches it.
- Tests: a fixture with a covered 120-minute gap and an uncovered 600-minute gap, checked by hand against both scripts.
- `docs/pricing-math.md`: refreshed the main-agent rows for 5 minutes with refresh and 1 hour with refresh.

## 0.1.3

- Stop hook: the deadline is one interval after the hook starts. The transcript at Stop can lack the current turn, which put the deadline in the past and fired the next wake about a second after the previous one. A final response that streams for more than 60 seconds can let the cache expire before the wake.
- Add `scripts/estimate-savings.js` (simulated cost per cache mode from local history, no tokens spent), `scripts/check-env.js`, `/warmcache:benchmark`, and `docs/benchmarks.md`.
- Add `AGENTS.md` for coding agents. `cache-report.js` exports its price table.

## 0.1.2

- State lives in `~/.claude/warmcache` by default. Any state directory must be a real directory owned by the user, created with mode 0700. Otherwise the hooks do nothing. Temp files get random names and are written exclusively. Stored values are validated.
- Stop hook: sleeps in 5-second slices so a superseded sleeper exits quickly. The deadline is the newest usage entry plus the interval, and a wake that would come more than 60 seconds late (for example after a suspend) is skipped.
- Subagent hook: stands down when background tasks are disabled or the subagent cache lifetime is 1 hour.
- Cost report: prices every model on the pricing page, Haiku 5.5 by prompt length. Prints skipped requests by model. Does not simulate wakes for main agents on a 5-minute cache. Adds the extra cost of expiries on the 5-minute simulation. Falls back to the total cache write count when the breakdown is missing, skips dangling symlinks, and filters by request time for `--days`.
- README and pricing math corrected after review.

## 0.1.1

- Cost report: the 5-minute what-if applies the measured miss rate by gap length instead of treating every gap of 5 minutes or more as a full rewrite.
- Add docs/pricing-math.md.
- README figures corrected.

## 0.1.0

- Cost report: `/warmcache:report` and `scripts/cache-report.js`.
- Subagent hook: denies foreground Bash timeouts above 270 seconds.
- Stop hook: wakes the session every 59 minutes, at most 4 times between real prompts, only after a 1-hour cache write.
