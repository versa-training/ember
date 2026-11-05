# Changelog

## 0.1.1

- Cost report: the 5-minute what-if applies the measured miss rate by gap length instead of treating every gap of 5 minutes or more as a full rewrite.
- Add docs/pricing-math.md.
- README figures corrected.

## 0.1.0

- Cost report: `/warmcache:report` and `scripts/cache-report.js`.
- Subagent hook: denies foreground Bash timeouts above 270 seconds.
- Stop hook: wakes the session every 59 minutes, at most 4 times between real prompts, only after a 1-hour cache write.
