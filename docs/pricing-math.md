# Pricing math

How prompt cache prices turn into the choice between a 5-minute and a 1-hour cache, with the numbers from the reference workload: one real, heavy multi-agent Claude Code workload. You need no prior context.

## 1. Current pricing

USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing as read on 2026-11-05. Prices can change. Check the page before relying on these figures.

| Model | Uncached input | 5-minute write | 1-hour write | Cache read and refresh | Output |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 |
| Sonnet 5.5 | 2 | 2.50 | 4 | 0.10 | 10 |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 |

The table shows the three models the reference workload used most. `scripts/cache-report.js` prices every model on the pricing page, and prices Haiku 5.5 per request by its own prompt length (over 100,000 tokens, counting input, cache reads, and cache writes, pays the higher tier).

Multipliers against uncached input: 5-minute write 1.25x, 1-hour write 2x, read 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x on most other models. The rest of this page uses 0.05x reads.

Terms:

- **Uncached input.** A prompt token that is not served from cache. Full input price.
- **Cache write.** A token stored in the cache for 5 minutes. Costs 1.25x input, paid once when the token is first written.
- **Premium (1-hour) write.** A token stored for 1 hour. Costs 2x input, paid once when the token is first written.
- **Cache read.** A token served from a live cache entry. Costs 0.05x input.
- **Refresh.** Any cache hit resets the entry's timer at the read price. There is no separate refresh fee. The timer runs from the start of the request.

## 2. The three numbers per token

Per token, as a multiple of uncached input price:

- **Extra cost of a 1-hour write: 0.75x** (2 minus 1.25). Paid once on every written token, whether or not the cache would have expired.
- **Cost of one 5-minute expiry: 1.2x** of the whole context (1.25 minus 0.05). The context is rewritten at the write price instead of read.
- **Cost of one refresh: 0.05x** of the whole context. One read.

## 3. Premium vs. expiry

Break-even is 0.625 expiries per written token (0.75 / 1.2). If you expect fewer expiries than that, the 5-minute cache is cheaper.

Read volume alone does not decide it. Reads cost the same on both lifetimes. The premium scales with new tokens written. An expiry scales with the whole context.

Worked example: a 300,000-token context adds 2,000 tokens per turn.

- Premium per turn: 2,000 x 0.75 = 1,500 token-equivalents.
- One expiry: 300,000 x 1.2 = 360,000 token-equivalents.
- One avoided pause pays for 360,000 / 1,500 = 240 turns.

## 4. Refresh vs. expiry

- 5-minute cache, wake every 4:30: one expiry (1.2x) equals 24 refreshes (1.2 / 0.05). Break-even is 24 wakes, 108 minutes of waiting.
- 1-hour cache, wake every 59 minutes: one expiry costs 1.95x (2 minus 0.05), which equals 39 refreshes (1.95 / 0.05). Break-even is 39 wakes, 38.35 hours of waiting.

## 5. Refresh vs. premium

Keeping a 5-minute cache alive with refreshes instead of paying the 1-hour premium: break-even is 15 wakes (0.75 / 0.05), which at 4.5 minutes each is 67.5 minutes of total waiting over an agent's life, at constant context. Beyond that, the premium is cheaper.

## 6. What this looks like on the reference workload

Same data throughout: 2026-09-29 to 2026-11-05, 157,267 requests, one heavy multi-agent workload, API list prices. Values marked simulated are not a real bill. Values marked measured come from recorded token counts at the lifetime that was used.

| Setup | Main | Subagents | Total | Basis |
| --- | --- | --- | --- | --- |
| Everything on 5 minutes | $7,127.03 (simulated) | $6,417.45 (measured) | $13,544.48 | expiry $4,468.12, 33.0% of total; range 32.1% to 35.0% depending on the expiry assumption |
| Main 1 hour, subagents 5 minutes (actual use) | $4,377.05 (measured) | $6,417.45 (measured) | $10,794.50 | expiry $1,448.41, 13.4% |
| Everything on 1 hour | $4,377.05 (measured) | $6,558.98 (simulated) | $10,936.03 | |

Main agent wake added to the main-1-hour setup, simulated: net $300.03 ($224.46 if sessions are abandoned), which leaves expiry plus wakes at $1,148 of a $10,494 total (10.9%). With subagent check-ins turned on as well: keepalive cost $138.80, expiry avoided $1,223.56, net $1,084.76 ($1,009.19 if sessions are abandoned).

A pause is 5 to 60 minutes between consecutive requests, followed by another request. Cost per agent, by number of pauses (all values simulated):

| Agents | Pauses | Count | 5-minute cost | 1-hour cost |
| --- | --- | --- | --- | --- |
| Main | 0 | 615 | $335.68 | $415.39 |
| Main | 1 | 30 | $77.42 | $81.10 |
| Main | 2 to 3 | 40 | $301.44 | $290.65 |
| Main | 4 or more | 116 | $6,413.58 | $3,593.25 |
| Subagents | 0 | 2,992 | $3,781.47 | $4,572.53 |
| Subagents | 1 | 179 | $668.17 | $667.45 |
| Subagents | 2 to 3 | 153 | $740.35 | $615.65 |
| Subagents | 4 or more | 137 | $1,238.51 | $703.36 |

Best lifetime per agent with hindsight (simulated): main $4,281.70, subagents $5,746.28.

76.8% of main agents and 86.4% of subagents never hit a pause. For those, 5 minutes is the right choice, which agrees with Anthropic's argument for the 5-minute default. In the reference workload 87.9% of subagents were general-purpose (3,459 of 3,935 `.meta.json` files), so choosing a lifetime by agent type was not useful.

Options (simulated unless marked measured):

| Agent | Option | Cost |
| --- | --- | --- |
| Main | 5 minutes, no refresh | $7,127 |
| Main | 5 minutes, with refresh | $4,529 (up to 4 wakes) to $4,926 (up to 24 wakes); a gap longer than the limit still expires, and every wake is paid. Figures from a newer run of `scripts/estimate-savings.js --days 0`, not the snapshot of the other rows |
| Main | 1 hour, no refresh | $4,377 (measured) |
| Main | 1 hour, with refresh | $4,177 (up to 4 wakes; newer run, same note as above) |
| Subagents | 5 minutes, no refresh | $6,417 (measured) |
| Subagents | 5 minutes, with refresh | $5,633 |
| Subagents | 5 minutes, up to 2 refreshes | $5,988 against $6,782 with no refresh (newer run, 38 days to 2026-11-06). The limit that ember uses; no limit gives $5,959 |
| Subagents | 1 hour, no refresh | $6,559 |
| Subagents | 1 hour, with refresh | not simulated |

## 7. The rule

- Main agent: 1 hour, with an optional wake at 59 minutes.
- Subagents: 5 minutes, with two refreshes during a long command. They need `EMBER_SUBAGENT=1`.

Why not request 1 hour only when a wait is coming: 1-hour entries must come before 5-minute entries in the prompt, so the cached prefix would probably be rewritten at 2x. This is an untested inference.

## 8. Limits

- Every dollar figure except the two marked measured is simulated from recorded token counts, not billed.
- The reference workload is one workload from one heavy multi-agent user. Yours will differ. Run `node scripts/cache-report.js` on your own transcripts.
- The 5-minute what-if uses measured miss rates by gap length (11.9% at 5 to 5.5 minutes up to 99.5% over 10 minutes).
- Refresh was not measured. Wake costs are modeled, and subscription quota weighting of cached reads is unknown.
- Prices and cache behavior can change without notice.
