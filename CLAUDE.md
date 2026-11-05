# AGENTS.md

ember is a Claude Code plugin (Node 22 or newer, no dependencies). It reports what expired prompt caches cost (`scripts/cache-report.js`) and keeps caches warm with hooks (`hooks/`). `CLAUDE.md` is a symlink to this file.

## Commands

- Tests: `npm test` (`node --test tests/*.test.js`)
- Savings estimate per mode from local history, free: `node scripts/estimate-savings.js --days 30`
- Offline cost report, free: `node scripts/cache-report.js --days 30`
- Environment check: `node scripts/check-env.js`
- Method and limits: `docs/benchmarks.md`

## Rules

- Use the scripts for all arithmetic and parsing. Never compute figures by hand.
- Benchmarks only read history and never start agents.
- Label every figure as measured or simulated, and name the machine and the dates.
- Never commit transcripts or results that contain personal data.
- No em or en dashes, no exclamation marks.
- Release: bump the version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry.

## Changing a price

Edit the `PRICES` table in `scripts/cache-report.js`, update the source date in the comment and `PRICES_DATE`, and update or add the test in `tests/` that shows the new numbers. The savings estimate reuses this table.
