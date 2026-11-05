#!/usr/bin/env node
'use strict';

// Reads Claude Code transcripts and estimates what expired prompt caches cost.
// Everything stays on your computer. Dollar figures use API list prices, so on a
// subscription they are an equivalent, not a bill.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// USD per million tokens. Source: platform.claude.com/docs/en/about-claude/pricing, 2026-11-05.
const PRICES_DATE = '2026-11-05';
// First match wins, so a longer id comes before any shorter id it contains
// (opus-5-5 before opus-5, opus-4-5 before opus-4). Model ids are matched after
// "." becomes "-".
const price = (match, input, write5m, write1h, read, output) => ({ match, input, write5m, write1h, read, output });
const PRICES = [
  price(['fable-5-1'], 10, 12.5, 20, 0.25, 50),
  price(['mythos-5-1'], 10, 12.5, 20, 0.25, 50),
  price(['fable-5'], 10, 12.5, 20, 1, 50),
  price(['mythos-5'], 10, 12.5, 20, 1, 50),
  price(['opus-5-5'], 4, 5, 8, 0.2, 20),
  price(['opus-5'], 5, 6.25, 10, 0.5, 25),
  price(['opus-4-8'], 5, 6.25, 10, 0.5, 25),
  price(['opus-4-7'], 5, 6.25, 10, 0.5, 25),
  price(['opus-4-6'], 5, 6.25, 10, 0.5, 25),
  price(['opus-4-5'], 5, 6.25, 10, 0.5, 25),
  price(['opus-4-1'], 15, 18.75, 30, 1.5, 75),
  price(['opus-4'], 15, 18.75, 30, 1.5, 75),
  price(['sonnet-5-5'], 2, 2.5, 4, 0.1, 10),
  price(['sonnet-5'], 2, 2.5, 4, 0.2, 10),
  price(['sonnet-4-6'], 3, 3.75, 6, 0.3, 15),
  price(['sonnet-4-5'], 3, 3.75, 6, 0.3, 15),
  price(['sonnet-4'], 3, 3.75, 6, 0.3, 15),
  {
    match: ['haiku-5-5'],
    tiers: [
      { upTo: 100000, ...price(null, 0.1, 0.125, 0.2, 0.01, 0.5) },
      { upTo: Infinity, ...price(null, 0.5, 0.625, 1, 0.05, 2.5) },
    ],
  },
  price(['haiku-4-5'], 1, 1.25, 2, 0.1, 5),
  price(['haiku-3-5', '3-5-haiku'], 0.8, 1, 1.6, 0.08, 4),
];

const MINIMUM_CONTEXT = 2000;
const WAKE_WRITE_TOKENS = 300;
const WAKE_OUTPUT_TOKENS = 50;
const SUBAGENT_WAKE_MIN = 4.5;
const MAIN_WAKE_MIN = { '5m': 4.5, '1h': 59 };
const MAIN_MAX_WAKES = 4;
const TTL_MIN = { '5m': 5, '1h': 59 };

// promptTokens (input, cache reads, and cache writes) picks the tier of a model priced by prompt length.
function priceFor(model, promptTokens = 0) {
  const id = String(model).replace(/\./g, '-');
  const entry = PRICES.find((candidate) => candidate.match.some((fragment) => id.includes(fragment)));
  if (!entry) return null;
  return entry.tiers ? entry.tiers.find((tier) => promptTokens <= tier.upTo) : entry;
}

const promptTokensOf = (use) => use.input + use.read + use.create;

function parseTranscript(text) {
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (!message?.usage || !message.id || !entry.timestamp) continue;
    const known = byId.get(message.id);
    if (known) known.usage = message.usage;
    else byId.set(message.id, { id: message.id, time: Date.parse(entry.timestamp), model: message.model, usage: message.usage });
  }
  return [...byId.values()];
}

function usageOf(request) {
  const usage = request.usage;
  const creation = usage.cache_creation ?? {};
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    read: usage.cache_read_input_tokens ?? 0,
    create: usage.cache_creation_input_tokens ?? 0,
    write5m: creation.ephemeral_5m_input_tokens ?? 0,
    write1h: creation.ephemeral_1h_input_tokens ?? 0,
  };
}

function emptyTotals() {
  return {
    files: 0, requests: 0, skipped: {}, noExpiryAt5m: 0, total: 0, misses: 0, rewritten: 0, expiry: 0,
    wakes: 0, wakeCost: 0, avoided: 0, abandonedWakeCost: 0, totalAt5m: 0, totalAt1h: 0,
  };
}

// Measured share of 5-minute caches that expired, by minutes since the previous request.
const MISS_RATE_5M = [
  { below: 5.5, rate: 0.119 },
  { below: 6, rate: 0.775 },
  { below: 7, rate: 0.865 },
  { below: 8, rate: 0.991 },
  { below: 10, rate: 0.993 },
  { below: Infinity, rate: 0.995 },
];

function missRate5m(gap) {
  return MISS_RATE_5M.find((band) => gap < band.below).rate;
}

// Prices a request as if every cache on this agent had the given lifetime.
// A 5-minute cache after a gap of 5 minutes or more is priced as an expected value:
// a miss rewrites the whole prefix, a hit reads the context and writes the rest.
function whatIf(price, use, gap, context, ttl) {
  const writePrice = ttl === '1h' || ttl === 'hit1h' ? price.write1h : price.write5m;
  const prefix = use.read + use.create;
  if (ttl === '1h') {
    if (gap !== null && gap >= 60 && context > MINIMUM_CONTEXT) return (prefix * writePrice) / 1e6;
    if (gap !== null && gap >= 5 && use.read < 0.5 * context && context > MINIMUM_CONTEXT) {
      const kept = Math.min(context, prefix);
      return ((kept * price.read) + ((prefix - kept) * writePrice)) / 1e6;
    }
  } else if (ttl === 'hit' || ttl === 'hit1h') {
    if (gap !== null && gap >= 5 && context > MINIMUM_CONTEXT) {
      const kept = Math.min(context, prefix);
      return ((kept * price.read) + ((prefix - kept) * (ttl === 'hit1h' ? price.write1h : price.write5m))) / 1e6;
    }
  } else if (gap !== null && gap >= 5 && context > MINIMUM_CONTEXT) {
    const rate = missRate5m(gap);
    const kept = Math.min(context, prefix);
    const miss = prefix * writePrice;
    const hit = (kept * price.read) + ((prefix - kept) * writePrice);
    return ((rate * miss) + ((1 - rate) * hit)) / 1e6;
  }
  return ((use.read * price.read) + (use.create * writePrice)) / 1e6;
}

// The wake simulation both scripts use. A gap of at least `threshold` minutes needs
// floor(gap / interval) wakes to keep the cache alive. The plugin sends at most
// `limit` of them, each paid whether or not the series reaches the next request.
// The gap is covered only when the limit is enough; otherwise the cache expires.
function wakePlan(gap, { threshold, interval, limit = Infinity }) {
  const needed = gap !== null && gap >= threshold ? Math.floor(gap / interval) : 0;
  return { needed, wakes: Math.min(needed, limit), covered: needed <= limit };
}

// Cost of one wake: the context is read from the cache, plus a short turn.
function wakeCost(price, context, ttl) {
  const wakeWrite = ttl === '1h' ? price.write1h : price.write5m;
  return (context * price.read + WAKE_WRITE_TOKENS * wakeWrite + WAKE_OUTPUT_TOKENS * price.output) / 1e6;
}

function addTranscript(totals, requests, isSubagent, seen) {
  totals.files += 1;
  let previous = null;
  let lastTtl = isSubagent ? '5m' : '1h';
  for (const request of requests) {
    const fresh = !seen.has(request.id);
    seen.add(request.id);
    const use = usageOf(request);
    const price = priceFor(request.model, promptTokensOf(use));
    if (!price && fresh) totals.skipped[request.model] = (totals.skipped[request.model] ?? 0) + 1;
    if (price && fresh) {
      if (use.write5m + use.write1h === 0 && use.create > 0) use[lastTtl === '1h' ? 'write1h' : 'write5m'] = use.create;
      const context = previous ? previous.read + previous.create : 0;
      const gap = previous ? (request.time - previous.time) / 60000 : null;
      if (use.write1h > 0) lastTtl = '1h';
      else if (use.write5m > 0) lastTtl = '5m';
      const writeCost = (use.write5m * price.write5m + use.write1h * price.write1h) / 1e6;
      const other = (use.read * price.read + use.input * price.input + use.output * price.output) / 1e6;
      const passthrough = (use.input * price.input + use.output * price.output) / 1e6;
      totals.requests += 1;
      totals.total += writeCost + other;
      totals.totalAt5m += passthrough + whatIf(price, use, gap, context, '5m');
      totals.noExpiryAt5m += passthrough + whatIf(price, use, gap, context, 'hit');
      totals.totalAt1h += passthrough + whatIf(price, use, gap, context, '1h');

      const ttl = isSubagent ? '5m' : lastTtl;
      if (gap !== null && gap >= TTL_MIN[ttl]) {
        const miss = context > MINIMUM_CONTEXT && use.read < 0.5 * context;
        const writes = use.write5m + use.write1h;
        const writePrice = writes ? writeCost / writes : (ttl === '1h' ? price.write1h : price.write5m) / 1e6;
        const rewritten = miss ? Math.min(Math.max(0, context - use.read), use.create) : 0;
        const extra = rewritten * (writePrice - price.read / 1e6);
        // The plugin wakes a main agent on either lifetime, up to the wake limit.
        const plan = isSubagent
          ? wakePlan(gap, { threshold: TTL_MIN['5m'], interval: SUBAGENT_WAKE_MIN })
          : wakePlan(gap, { threshold: TTL_MIN[ttl], interval: MAIN_WAKE_MIN[ttl], limit: MAIN_MAX_WAKES });
        const { needed, wakes } = plan;
        totals.wakes += wakes;
        totals.wakeCost += wakes * wakeCost(price, context, ttl);
        if (miss) {
          totals.misses += 1;
          totals.rewritten += rewritten;
          totals.expiry += extra;
          if (wakes > 0 && plan.covered) totals.avoided += extra;
        }
      }
    }
    if (price) previous = { ...use, time: request.time };
  }
  if (!isSubagent && previous) {
    const lastPrice = priceFor(requests[requests.length - 1].model, promptTokensOf(previous));
    if (lastPrice) {
      totals.abandonedWakeCost += MAIN_MAX_WAKES * (((previous.read + previous.create) * lastPrice.read) / 1e6);
    }
  }
}

function modifiedSince(file, sinceMs) {
  try {
    return fs.statSync(file).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function listTranscripts(root, sinceMs) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl') && modifiedSince(full, sinceMs)) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

function analyze(root, sinceMs) {
  const result = { main: emptyTotals(), subagent: emptyTotals() };
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
    if (requests.length) addTranscript(isSubagent ? result.subagent : result.main, requests, isSubagent, seen);
  }
  return result;
}

const usd = (value) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const millions = (value) => `${(value / 1e6).toFixed(1)}M`;
const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a');

function skippedLines(main, subagent) {
  const merged = {};
  for (const counts of [main.skipped, subagent.skipped]) {
    for (const [model, count] of Object.entries(counts)) merged[model] = (merged[model] ?? 0) + count;
  }
  const entries = Object.entries(merged).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return [];
  return [`Skipped requests by model: ${entries.map(([model, count]) => `${model} ${count}`).join(', ')}.`];
}

function format(result, days) {
  const { main, subagent } = result;
  const total = main.total + subagent.total;
  const expiry = main.expiry + subagent.expiry;
  const row = (label, a, b, c) => `${label.padEnd(34)}${a.padStart(14)}${b.padStart(14)}${c.padStart(14)}`;
  const extra5m = (t) => t.totalAt5m - t.noExpiryAt5m;
  const saved = (t) => t.avoided - t.wakeCost;
  return [
    `ember report, ${days ? `last ${days} days` : 'all transcripts'}. Estimates at API list prices.`,
    '',
    row('', 'Main', 'Subagents', 'Total'),
    row('Requests', String(main.requests), String(subagent.requests), String(main.requests + subagent.requests)),
    row('Total cost', usd(main.total), usd(subagent.total), usd(total)),
    row('Cache expiries after a wait', String(main.misses), String(subagent.misses), String(main.misses + subagent.misses)),
    row('Tokens rewritten', millions(main.rewritten), millions(subagent.rewritten), millions(main.rewritten + subagent.rewritten)),
    row('Extra cost of expiries', usd(main.expiry), usd(subagent.expiry), usd(expiry)),
    row('Share of total cost', percent(main.expiry, main.total), percent(subagent.expiry, subagent.total), percent(expiry, total)),
    '',
    'Simulated keepalive (not measured). Main-agent wakes are simulated only where the cache lifetime is 1 hour, because the plugin does not wake 5-minute main sessions; their wakes and avoided expiry stay zero:',
    row('Wakes', String(main.wakes), String(subagent.wakes), String(main.wakes + subagent.wakes)),
    row('Keepalive cost', usd(main.wakeCost), usd(subagent.wakeCost), usd(main.wakeCost + subagent.wakeCost)),
    row('Expiry cost avoided', usd(main.avoided), usd(subagent.avoided), usd(main.avoided + subagent.avoided)),
    row('Net saving', usd(saved(main)), usd(saved(subagent)), usd(saved(main) + saved(subagent))),
    row('Net if sessions are abandoned', usd(saved(main) - main.abandonedWakeCost), usd(saved(subagent)), usd(saved(main) + saved(subagent) - main.abandonedWakeCost)),
    '',
    'Simulated total cost on a fixed cache lifetime. Every write pays that lifetime\'s price:',
    row('Everything on 5 minutes', usd(main.totalAt5m), usd(subagent.totalAt5m), usd(main.totalAt5m + subagent.totalAt5m)),
    row('  Extra cost of expiries', usd(extra5m(main)), usd(extra5m(subagent)), usd(extra5m(main) + extra5m(subagent))),
    row('  Share of that total', percent(extra5m(main), main.totalAt5m), percent(extra5m(subagent), subagent.totalAt5m), percent(extra5m(main) + extra5m(subagent), main.totalAt5m + subagent.totalAt5m)),
    row('Main 1 hour, subagents 5 minutes', usd(main.totalAt1h), usd(subagent.totalAt5m), usd(main.totalAt1h + subagent.totalAt5m)),
    row('Everything on 1 hour', usd(main.totalAt1h), usd(subagent.totalAt1h), usd(main.totalAt1h + subagent.totalAt1h)),
    '',
    'Assumes the same requests and pauses. Models without a listed price are skipped.',
    ...skippedLines(main, subagent),
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const days = option('--days') === undefined ? 30 : Number(option('--days'));
  if (!Number.isFinite(days) || days < 0) {
    process.stderr.write('Usage: cache-report.js [--days N] [--dir PATH] [--json]. --days 0 reads everything.\n');
    return 1;
  }
  const root = option('--dir') ?? path.join(os.homedir(), '.claude', 'projects');
  const sinceMs = days ? Date.now() - days * 86400000 : 0;
  const result = analyze(root, sinceMs);
  process.stdout.write(`${args.includes('--json') ? JSON.stringify(result, null, 2) : format(result, days)}\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  listTranscripts, skippedLines, wakeCost, wakePlan, promptTokensOf, usd, percent,
  MINIMUM_CONTEXT, SUBAGENT_WAKE_MIN, MAIN_WAKE_MIN, MAIN_MAX_WAKES,
  PRICES, PRICES_DATE, usageOf, missRate5m, whatIf, parseTranscript, addTranscript, emptyTotals, priceFor, format, analyze };
