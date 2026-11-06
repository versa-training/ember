# Changelog

## 0.5.0

- The subagent hook is off by default. `EMBER_SUBAGENT=1` turns it on. It judges a command by its declared timeout, so it refused many commands that would have finished quickly, and each refusal costs a request.
- The headline figure is now 10.9% for the main agent wake alone. The 3.7% figure included subagent check-ins.

## 0.4.0

- A session can have its own wake limit. `/ember:wakes <count>` or `scripts/set-wakes.js <count>` stores it in the session's state file, where it wins over `EMBER_MAX_WAKES` and stays until the session ends.

## 0.3.0

- ember adapts to the configured cache lifetime per agent type. One resolver, `hooks/ember-config.js`, is read fresh on every hook call and by `scripts/check-env.js`. Main agent: `EMBER_MAIN_TTL`, the newest cache write in the transcript, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl`, `ENABLE_PROMPT_CACHING_1H`. Subagents: `EMBER_SUBAGENT_TTL`, the force switch, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`, the hour switch, then 5 minutes. Settings files include managed settings and `env` blocks.
- Intervals follow the lifetime: 270 seconds for 5 minutes, 3540 for 1 hour. The main agent now wakes on a 5-minute cache. The sleeper resolves again about once a minute and before waking, so a settings change moves its deadline.
- The subagent hook uses the subagent lifetime for its limit, and the check on `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` is gone. Its deny text now gives a polling command and says why not to wait for the finish notification, which fixed a live run where the subagent's cache expired.
- New: `EMBER_WAKE_MESSAGE`, `EMBER_MAIN_TTL`, `EMBER_SUBAGENT_TTL`, and the testing aids `EMBER_LOG`, `EMBER_RESOLVE_MS`, `EMBER_TRANSCRIPT_ROOT`.
- `check-env.js` prints the resolved lifetime, interval, and wake limit per agent type with sources.
- `cache-report.js` and `estimate-savings.js` simulate main-agent wakes on a 5-minute cache again.
- Tests for the resolver, precedence, malformed settings, and a deadline that moves.

## 0.2.1

- README rewritten as a project page for you and your agent. New logo in `assets/logo.png`. `assets/1-headline.png` is gone. The chart caption now names the reference workload.
- `docs/pricing-math.md` and `docs/benchmarks.md` refer to the reference workload. No figure changed.
- `AGENTS.md`: figures from the reference workload stay labeled simulated. `CLAUDE.md` is now the symlink `AGENTS.md` says it is.

## 0.2.0

- The project was renamed from warmcache to ember. Commands are `/ember:report` and `/ember:benchmark`, environment variables are `EMBER_*`, the default state directory is `~/.claude/ember`, and the wake message starts with `ember keepalive`. Entries below use the new name.

## 0.1.4

- `estimate-savings.js` priced the "1 hour, wake every 59 min" row with the 5-minute write price on every request that had no pause, so the row came out about $265 too low on the measured data and disagreed with `cache-report.js`. `whatIf` now prices `hit1h` at the 1-hour write price.
- `cache-report.js` and `estimate-savings.js` share one wake simulation, `wakePlan`: the wakes sent are capped at the limit, and a gap is covered only when the limit reaches it.
- Tests: a fixture with a covered 120-minute gap and an uncovered 600-minute gap, checked by hand against both scripts.
- `docs/pricing-math.md`: refreshed the main-agent rows for 5 minutes with refresh and 1 hour with refresh.

## 0.1.3

- Stop hook: the deadline is one interval after the hook starts. The transcript at Stop can lack the current turn, which put the deadline in the past and fired the next wake about a second after the previous one. A final response that streams for more than 60 seconds can let the cache expire before the wake.
- Add `scripts/estimate-savings.js` (simulated cost per cache mode from local history, no tokens spent), `scripts/check-env.js`, `/ember:benchmark`, and `docs/benchmarks.md`.
- Add `AGENTS.md` for coding agents. `cache-report.js` exports its price table.

## 0.1.2

- State lives in `~/.claude/ember` by default. Any state directory must be a real directory owned by the user, created with mode 0700. Otherwise the hooks do nothing. Temp files get random names and are written exclusively. Stored values are validated.
- Stop hook: sleeps in 5-second slices so a superseded sleeper exits quickly. The deadline is the newest usage entry plus the interval, and a wake that would come more than 60 seconds late (for example after a suspend) is skipped.
- Subagent hook: stands down when background tasks are disabled or the subagent cache lifetime is 1 hour.
- Cost report: prices every model on the pricing page, Haiku 5.5 by prompt length. Prints skipped requests by model. Does not simulate wakes for main agents on a 5-minute cache. Adds the extra cost of expiries on the 5-minute simulation. Falls back to the total cache write count when the breakdown is missing, skips dangling symlinks, and filters by request time for `--days`.
- README and pricing math corrected after review.

## 0.1.1

- Cost report: the 5-minute what-if applies the measured miss rate by gap length instead of treating every gap of 5 minutes or more as a full rewrite.
- Add docs/pricing-math.md.
- README figures corrected.

## 0.1.0

- Cost report: `/ember:report` and `scripts/cache-report.js`.
- Subagent hook: denies foreground Bash timeouts above 270 seconds.
- Stop hook: wakes the session every 59 minutes, at most 4 times between real prompts, only after a 1-hour cache write.
