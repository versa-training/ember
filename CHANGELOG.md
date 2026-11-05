# Changelog

## 0.1.0

- Cost report: `/warmcache:report` and `scripts/cache-report.js`.
- Subagent hook: denies foreground Bash timeouts above 270 seconds.
- Stop hook: wakes the session every 59 minutes, at most 4 times between real prompts, only after a 1-hour cache write.
