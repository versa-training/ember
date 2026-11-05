# warmcache

Find out what expired prompt caches cost you in Claude Code, and keep them warm with two small hooks.

> **EXPERIMENTAL. READ THIS BEFORE INSTALLING.** This plugin depends on cache lifetimes, prices, and hook behavior that Anthropic controls and can change at any time, without notice. Used wrongly, it can cost you more, not less.
>
> This has happened before. Users measured Claude Code cache writes moving from 1 hour to 5 minutes around early March 2026, with no announcement they could find ([issue 46829](https://github.com/anthropics/claude-code/issues/46829), closed as not planned). A later report says 2.1.218 and newer stopped requesting 1 hour ([issue 84253](https://github.com/anthropics/claude-code/issues/84253), unconfirmed). Anthropic's replies in the first issue describe this as deliberate optimization, not a regression. The commenter [bcherny](https://github.com/anthropics/claude-code/issues/46829#issuecomment-4237689126) wrote: "we use experiment gates that are cached client-side" and "We also are not defaulting API customers to 1h yet".
>
> Run the report before and after any Claude Code upgrade.

## What it costs

![Headline numbers](assets/1-headline.png)

![The three bills](assets/2-three-bills.png)

| Scenario | Total |
| --- | --- |
| Everything on 5 minutes | $14,116.50 |
| Main 1 hour, subagents 5 minutes | $10,981.32 |
| Everything on 1 hour | $10,954.78 |

Simulated from one heavy multi-agent machine: 157,267 requests from 2026-09-29 to 2026-11-05, API list prices, not a real bill. The same requests and pauses are assumed in every row. Run the report for your own numbers, because yours will differ.

## The other side

Anthropic's [reply](https://github.com/anthropics/claude-code/issues/46829#issuecomment-4231266649) makes these points:

- 1-hour writes cost more (2x vs. 1.25x) and do not pay off for one-shot requests.
- The client selects a lifetime per request.
- The change lowers cost across the request mix.

This report charges every write at the lifetime's price, so one-shot requests are counted.

On this data, subagents are close to a wash: $6,571.62 on 5 minutes vs. $6,545.08 on 1 hour in simulation, against $6,417.45 actually spent. That supports per-request selection. The main agent saves far more on 1 hour on this workload: $7,544.88 vs. $4,409.70.

Anthropic's claim covers all users, which this data cannot test. bcherny also wrote that the savings are "nowhere near 12x" and "a small win".

## Before you install

- Claude Code 2.1.318 changelog: "Changed background subagents to move a shell command to the background after 3 minutes on all providers, so the prompt cache doesn't expire while it runs".
- Claude Code 2.1.314 changelog: "Added idle compaction to VS Code and Claude Desktop's Code tab: a 200K+ token conversation left idle is summarized, and the summary is used on your next message if the prompt cache has expired".

Newer versions may already cover part of this.

API users should first set `"promptCacheTtl": "1h"` in settings. It needs v2.1.242 or later and no plugin.

Subscription users: wakes use plan quota, how quota weights cached reads is unknown, and the savings are not proven for subscriptions.

## How it works

- **Subagent hook.** A PreToolUse hook denies foreground Bash timeouts above 270 seconds in subagents. It does not shorten them, because a test showed a shortened timeout killed the command with exit code 143. The denial tells the subagent to rerun in the background.
- **Stop hook.** A Stop hook with `asyncRewake` sleeps 59 minutes, then wakes the session for a one-word turn. It wakes at most 4 times between real prompts, and only when the last cache write was 1 hour. Each wake is a real turn in the transcript.

## Test status

Unit tests pass (`npm test`). Only the following was run against Claude Code:

- `asyncRewake` woke a headless stream-json session on Claude Code 2.1.310 with a 12-second interval, and the wake limit of 2 held.
- Subagent hook, 2.1.310, haiku, cap set to 5 seconds: a subagent asked to run `sleep 12; echo finished` with a long Bash timeout was denied, then reran the same command with `run_in_background: true` and read the output `finished`. One run.

Untested: an interactive idle session and the real 59-minute interval.

## Install

Requirements: Node 22 or newer on PATH.

```text
/plugin marketplace add versa-training/warmcache
/plugin install warmcache@warmcache
```

Restart Claude Code.

## Commands

- `/warmcache:report` prints the cost report.
- `node scripts/cache-report.js --days N --dir PATH --json` runs it from a clone.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `WARMCACHE_MAIN=0` | on | Turns off the Stop hook wakes. |
| `WARMCACHE_SUBAGENT=0` | on | Turns off the subagent hook. |
| `WARMCACHE_SUBAGENT_WAIT_MS` | 270000 | Longest foreground Bash timeout a subagent may use. |
| `WARMCACHE_MAIN_INTERVAL_SEC` | 3540 | Seconds between wakes. Setting it also skips the 1-hour check. |
| `WARMCACHE_MAX_WAKES` | 4 | Wakes allowed between real prompts. |
| `WARMCACHE_STATE_DIR` | `warmcache` in the OS temp dir | Where wake state is stored. |

## Privacy

Everything stays local. The plugin makes no network calls.

## Similar projects

- [claude-code-cache-keepalive](https://github.com/yujiachen-y/claude-code-cache-keepalive) uses a blocking Stop hook. Its README warns it makes things worse on subscriptions.
- [claude-code-cache-warmer](https://github.com/AshitaOrbis/claude-code-cache-warmer) uses a local proxy and a replay timer.

## Development

```bash
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## About

warmcache is from the team behind [versa.training](https://versa.training). Looking for a tool to help your team master difficult conversations? Check out [versa.training](https://versa.training).

## License

[MIT](LICENSE)
