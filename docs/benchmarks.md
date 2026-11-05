# Estimating your savings

`scripts/estimate-savings.js` estimates what each cache mode would cost on your own Claude Code history. It reads local transcripts only. It starts no agent, makes no model call, and spends no tokens.

## Run it

```bash
node scripts/check-env.js
node scripts/estimate-savings.js --days 30
```

Flags: `--days N` (default 30, 0 reads everything and can take minutes on large histories), `--dir PATH` (default `~/.claude/projects`), `--json`.

## Modes

| Mode | Meaning |
| --- | --- |
| Actual | Your requests priced as they happened, at API list prices. |
| 5 minutes, no refresh | Every cache write lives 5 minutes. |
| 5 minutes, check-in every 4:30 | Subagents check in before the cache expires. For main agents the output simulates wakes every 4:30 with up to 4, 12, and 24 wakes. |
| 1 hour, no refresh | Every cache write lives 1 hour. |
| 1 hour, wake every 59 min, up to 4 | Main agents only. This is what the Stop hook does. |

## Reading the output

1. Cache lifetime now: the lifetime in your last 2 days of transcripts (measured). If it is 5 minutes, the 1-hour rows are what you would gain by switching.
2. Agents by pauses: a pause is 5 to 60 minutes between two requests of one agent. Agents with 0 pauses never benefit from a longer lifetime. Agents with 4 or more pauses benefit most.
3. Pauses by length: short pauses (5 to 10 minutes) favor a 5-minute check-in. Long ones favor 1 hour.
4. Cost per mode: the simulated total for each mode, then the saving against actual in dollars and percent. A negative saving means the mode costs more than what you did.
5. Share the hook cannot reach: the part of simulated subagent expiry cost on gaps that were not preceded by a foreground Bash call with a timeout above 270 seconds. The subagent hook only acts on such calls, so the check-in row is an upper bound.

Every figure is simulated at API list prices. On a subscription, dollars are an equivalent, not a bill.

## Limits

- Nothing is measured. The same requests and pauses are assumed in every mode, so a changed lifetime that would change your behavior is not modeled.
- Cache misses at 5 minutes use a measured miss rate by gap length from one machine (see `docs/pricing-math.md`).
- Wake turns are assumed to cost 300 cache-written tokens and 50 output tokens plus a read of the context.
- Models without a listed price are skipped and listed.
- Prices and cache behavior change on Anthropic's side. Record your Claude Code version (`check-env.js`) and the date with any result you share.
- A pause of 5 to 60 minutes between requests counts whether the agent was waiting for a person or a tool.
