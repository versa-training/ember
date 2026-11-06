#!/usr/bin/env node
'use strict';

// Estimates what each cache mode would cost on your own Claude Code history.
// It only reads local transcripts. It starts no agent and spends no tokens.
// Every figure is simulated at API list prices from the same requests and pauses.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseTranscript, usageOf, priceFor, whatIf, wakeCost, wakePlan, addTranscript, emptyTotals, listTranscripts,
  skippedLines, promptTokensOf, usd, percent, PRICES_DATE, SUBAGENT_WAKE_MIN, MAIN_WAKE_MIN, MAIN_MAX_WAKES,
} = require('./cache-report');
const { recentLifetime } = require('./check-env');

const LONG_BASH_MS = 270000;
const MAIN_WAKE_LIMITS = [4, 12, 24];
const SUBAGENT_CHECK_LIMITS = [1, 2, 3, 4];
const PAUSE_MIN = 5;
const PAUSE_MAX = 60;
const LENGTH_BUCKETS = [
  { label: '5 to 10 min', below: 10 },
  { label: '10 to 30 min', below: 30 },
  { label: '30 to 60 min', below: 60 },
];
const COUNT_BUCKETS = ['0 pauses', '1 pause', '2 to 3 pauses', '4 or more pauses'];

const countBucket = (n) => (n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3);

// Ids of requests that ran a foreground Bash call with a timeout above 270 seconds.
function longBashIds(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (!line.includes('"Bash"') || !line.includes('tool_use')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content) || !entry.message.id) continue;
    for (const item of content) {
      if (item?.type === 'tool_use' && item.name === 'Bash' && item.input?.timeout > LONG_BASH_MS && !item.input.run_in_background) ids.add(entry.message.id);
    }
  }
  return ids;
}

function emptyGroup() {
  const sims = { no5m: 0, no1h: 0, refresh5m: 0, refresh1h: 0 };
  for (const n of MAIN_WAKE_LIMITS) sims[`refresh5m-${n}`] = 0;
  for (const n of SUBAGENT_CHECK_LIMITS) sims[`check-${n}`] = 0;
  return {
    totals: emptyTotals(), agents: 0, sims,
    agentPauses: [0, 0, 0, 0], pauseLengths: LENGTH_BUCKETS.map(() => 0),
    expiryAll: 0, expiryUnreachable: 0,
  };
}

// Adds one agent's requests to the group's simulated costs and usage patterns.
function simulate(group, requests, fresh, isSubagent, longBash) {
  let previous = null;
  let pauses = 0;
  const { sims } = group;
  requests.forEach((request, index) => {
    const use = usageOf(request);
    const price = priceFor(request.model, promptTokensOf(use));
    if (price && fresh[index]) {
      const context = previous ? previous.read + previous.create : 0;
      const gap = previous ? (request.time - previous.time) / 60000 : null;
      const pass = (use.input * price.input + use.output * price.output) / 1e6;
      const at = (ttl) => pass + whatIf(price, use, gap, context, ttl);
      sims.no5m += at('5m');
      sims.no1h += at('1h');
      const paused = gap !== null && gap >= PAUSE_MIN;
      const series = (ttl, plan, covered, uncovered) => at(plan.covered ? covered : uncovered) + plan.wakes * wakeCost(price, context, ttl);
      if (isSubagent) {
        sims.refresh5m += series('5m', wakePlan(gap, { threshold: PAUSE_MIN, interval: SUBAGENT_WAKE_MIN }), 'hit', '5m');
        for (const n of SUBAGENT_CHECK_LIMITS) {
          sims[`check-${n}`] += series('5m', wakePlan(gap, { threshold: PAUSE_MIN, interval: SUBAGENT_WAKE_MIN, limit: n }), 'hit', '5m');
        }
      } else {
        for (const n of MAIN_WAKE_LIMITS) {
          sims[`refresh5m-${n}`] += series('5m', wakePlan(gap, { threshold: PAUSE_MIN, interval: SUBAGENT_WAKE_MIN, limit: n }), 'hit', '5m');
        }
        sims.refresh1h += series('1h', wakePlan(gap, { threshold: MAIN_WAKE_MIN['1h'], interval: MAIN_WAKE_MIN['1h'], limit: MAIN_MAX_WAKES }), 'hit1h', '1h');
      }
      if (paused && gap < PAUSE_MAX) {
        pauses += 1;
        group.pauseLengths[LENGTH_BUCKETS.findIndex((bucket) => gap < bucket.below)] += 1;
      }
      if (isSubagent && paused) {
        const expiry = whatIf(price, use, gap, context, '5m') - whatIf(price, use, gap, context, 'hit');
        group.expiryAll += expiry;
        if (!longBash.has(previous.id)) group.expiryUnreachable += expiry;
      }
    }
    if (price) previous = { ...use, time: request.time, id: request.id, price };
  });
  if (!isSubagent && previous) {
    // A wake series that ends with the session: each wake reads the context for nothing.
    const read = (previous.read + previous.create) * previous.price.read / 1e6;
    for (const n of MAIN_WAKE_LIMITS) sims[`refresh5m-${n}`] += n * read;
    sims.refresh1h += MAIN_MAX_WAKES * read;
  }
  if (previous) {
    group.agents += 1;
    group.agentPauses[countBucket(pauses)] += 1;
  }
}

function estimate(root, sinceMs) {
  const result = { main: emptyGroup(), subagent: emptyGroup() };
  const seen = new Set();
  for (const file of listTranscripts(root, sinceMs)) {
    const isSubagent = file.split(path.sep).includes('subagents');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const requests = parseTranscript(text).filter((request) => request.time >= sinceMs);
    if (requests.length === 0) continue;
    const fresh = requests.map((request) => !seen.has(request.id));
    const group = isSubagent ? result.subagent : result.main;
    addTranscript(group.totals, requests, isSubagent, seen);
    simulate(group, requests, fresh, isSubagent, isSubagent ? longBashIds(text) : new Set());
  }
  return result;
}

function modeRows(group, isSubagent) {
  const actual = group.totals.total;
  const rows = [{ mode: 'Actual (measured requests, list prices)', cost: actual }];
  rows.push({ mode: '5 minutes, no refresh', cost: group.sims.no5m });
  if (isSubagent) {
    for (const n of SUBAGENT_CHECK_LIMITS) rows.push({ mode: `5 minutes, check-in every 4:30, up to ${n}`, cost: group.sims[`check-${n}`] });
    rows.push({ mode: '5 minutes, check-in every 4:30, no limit', cost: group.sims.refresh5m });
  }
  else for (const n of MAIN_WAKE_LIMITS) rows.push({ mode: `5 minutes, wake every 4:30, up to ${n}`, cost: group.sims[`refresh5m-${n}`] });
  rows.push({ mode: '1 hour, no refresh', cost: group.sims.no1h });
  if (!isSubagent) rows.push({ mode: `1 hour, wake every 59 min, up to ${MAIN_MAX_WAKES}`, cost: group.sims.refresh1h });
  return rows.map((row, index) => ({ ...row, saving: index === 0 ? null : actual - row.cost, share: index === 0 || !actual ? null : (actual - row.cost) / actual }));
}

function signed(value) {
  return `${value < 0 ? '-' : '+'}${usd(Math.abs(value))}`;
}

function format(result, days, root, lifetime) {
  const out = [`ember savings estimate, ${days ? `last ${days} days` : 'all transcripts'}, from ${root}.`];
  out.push(`SIMULATED. Nothing was measured and no agent was run. API list prices dated ${PRICES_DATE}. Same requests and pauses in every row.`, '');
  out.push(lifetime
    ? `Cache lifetime now (transcripts of the last 2 days): newest write ${lifetime.newest}, ${(lifetime.share1h * 100).toFixed(1)}% of written tokens at 1h (measured).`
    : 'Cache lifetime now: no cache writes found in the last 2 days.', '');
  for (const [name, group, isSubagent] of [['Main agents', result.main, false], ['Subagents', result.subagent, true]]) {
    out.push(`${name}: ${group.agents} agents, ${group.totals.requests} priced requests`);
    out.push('  Agents by pauses (a pause is 5 to 60 minutes between requests, followed by another request):');
    COUNT_BUCKETS.forEach((label, i) => out.push(`    ${label.padEnd(18)}${String(group.agentPauses[i]).padStart(8)}  ${percent(group.agentPauses[i], group.agents).padStart(6)}`));
    out.push('  Pauses by length:');
    LENGTH_BUCKETS.forEach((bucket, i) => out.push(`    ${bucket.label.padEnd(18)}${String(group.pauseLengths[i]).padStart(8)}`));
    out.push(`  Simulated cost per mode, saving against actual:`);
    for (const row of modeRows(group, isSubagent)) {
      out.push(`    ${row.mode.padEnd(42)}${usd(row.cost).padStart(14)}${row.saving === null ? ''.padStart(26) : `${signed(row.saving).padStart(15)}${(`${(row.share * 100).toFixed(1)}%`).padStart(11)}`}`);
    }
    if (isSubagent) {
      out.push(`  Share of simulated expiry cost the hook cannot reach (no foreground Bash timeout above 270 s before the gap): ${percent(group.expiryUnreachable, group.expiryAll)} (${usd(group.expiryUnreachable)} of ${usd(group.expiryAll)}). The check-in row above assumes every gap is reachable.`);
    }
    out.push('');
  }
  out.push('Models without a listed price are skipped.', ...skippedLines(result.main.totals, result.subagent.totals));
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const days = option('--days') === undefined ? 30 : Number(option('--days'));
  if (!Number.isFinite(days) || days < 0) {
    process.stderr.write('Usage: estimate-savings.js [--days N] [--dir PATH] [--json]. --days 0 reads everything.\n');
    return 1;
  }
  const root = option('--dir') ?? path.join(os.homedir(), '.claude', 'projects');
  const result = estimate(root, days ? Date.now() - days * 86400000 : 0);
  const lifetime = recentLifetime(root);
  if (result.main.agents + result.subagent.agents === 0) {
    const skipped = skippedLines(result.main.totals, result.subagent.totals);
    process.stdout.write(`${[`No transcripts with priced requests found in ${root} for ${days ? `the last ${days} days` : 'any date'}.`, ...skipped].join('\n')}\n`);
    return 0;
  }
  process.stdout.write(`${args.includes('--json') ? JSON.stringify({ ...result, lifetime }, null, 2) : format(result, days, root, lifetime)}\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { estimate, format, modeRows, longBashIds, countBucket };
