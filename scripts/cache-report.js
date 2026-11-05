#!/usr/bin/env node
'use strict';

// Reads Claude Code transcripts and estimates what expired prompt caches cost.
// Everything stays on this machine. Dollar figures use API list prices, so on a
// subscription they are an equivalent, not a bill.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// USD per million tokens. Source: platform.claude.com/docs/en/about-claude/pricing, 2026-11-05.
const PRICES = [
  { match: 'opus-5-5', input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  { match: 'sonnet-5-5', input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  { match: 'haiku-4-5', input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 },
];

const MINIMUM_CONTEXT = 2000;
const WAKE_WRITE_TOKENS = 300;
const WAKE_OUTPUT_TOKENS = 50;
const SUBAGENT_WAKE_MIN = 4.5;
const MAIN_WAKE_MIN = { '5m': 4.5, '1h': 59 };
const MAIN_MAX_WAKES = 4;
const TTL_MIN = { '5m': 5, '1h': 59 };

function priceFor(model) {
  return PRICES.find((price) => String(model).includes(price.match)) ?? null;
}

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
    files: 0, requests: 0, total: 0, misses: 0, rewritten: 0, expiry: 0,
    wakes: 0, wakeCost: 0, avoided: 0, abandonedWakeCost: 0, totalAt5m: 0, totalAt1h: 0,
  };
}

// Prices a request as if every cache on this agent had the given lifetime.
function whatIf(price, use, gap, context, ttl) {
  const writePrice = ttl === '1h' ? price.write1h : price.write5m;
  const prefix = use.read + use.create;
  if (gap !== null && gap >= (ttl === '1h' ? 60 : 5) && context > MINIMUM_CONTEXT) return (prefix * writePrice) / 1e6;
  if (gap !== null && gap >= 5 && use.read < 0.5 * context && context > MINIMUM_CONTEXT) {
    const kept = Math.min(context, prefix);
    return ((kept * price.read) + ((prefix - kept) * writePrice)) / 1e6;
  }
  return ((use.read * price.read) + (use.create * writePrice)) / 1e6;
}

function addTranscript(totals, requests, isSubagent, seen) {
  totals.files += 1;
  let previous = null;
  let lastTtl = isSubagent ? '5m' : '1h';
  for (const request of requests) {
    const price = priceFor(request.model);
    const fresh = !seen.has(request.id);
    seen.add(request.id);
    const use = usageOf(request);
    if (price && fresh) {
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
      totals.totalAt1h += passthrough + whatIf(price, use, gap, context, '1h');

      const ttl = isSubagent ? '5m' : lastTtl;
      if (gap !== null && gap >= TTL_MIN[ttl]) {
        const miss = context > MINIMUM_CONTEXT && use.read < 0.5 * context;
        const writes = use.write5m + use.write1h;
        const writePrice = writes ? writeCost / writes : (ttl === '1h' ? price.write1h : price.write5m) / 1e6;
        const rewritten = miss ? Math.min(Math.max(0, context - use.read), use.create) : 0;
        const extra = rewritten * (writePrice - price.read / 1e6);
        const interval = isSubagent ? SUBAGENT_WAKE_MIN : MAIN_WAKE_MIN[ttl];
        const needed = Math.floor(gap / interval);
        const wakes = isSubagent ? needed : Math.min(needed, MAIN_MAX_WAKES);
        const wakeWrite = ttl === '1h' ? price.write1h : price.write5m;
        const overhead = (WAKE_WRITE_TOKENS * wakeWrite + WAKE_OUTPUT_TOKENS * price.output) / 1e6;
        totals.wakes += wakes;
        totals.wakeCost += wakes * ((context * price.read) / 1e6 + overhead);
        if (miss) {
          totals.misses += 1;
          totals.rewritten += rewritten;
          totals.expiry += extra;
          if (needed === wakes) totals.avoided += extra;
        }
      }
    }
    if (price) previous = { ...use, time: request.time };
  }
  if (!isSubagent && previous) {
    const lastPrice = priceFor(requests[requests.length - 1].model);
    if (lastPrice) {
      totals.abandonedWakeCost += MAIN_MAX_WAKES * (((previous.read + previous.create) * lastPrice.read) / 1e6);
    }
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
      else if (entry.name.endsWith('.jsonl') && fs.statSync(full).mtimeMs >= sinceMs) files.push(full);
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
    const requests = parseTranscript(fs.readFileSync(file, 'utf8'));
    if (requests.length) addTranscript(isSubagent ? result.subagent : result.main, requests, isSubagent, seen);
  }
  return result;
}

const usd = (value) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const millions = (value) => `${(value / 1e6).toFixed(1)}M`;
const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a');

function format(result, days) {
  const { main, subagent } = result;
  const total = main.total + subagent.total;
  const expiry = main.expiry + subagent.expiry;
  const row = (label, a, b, c) => `${label.padEnd(34)}${a.padStart(14)}${b.padStart(14)}${c.padStart(14)}`;
  const saved = (t) => t.avoided - t.wakeCost;
  return [
    `warmcache report, ${days ? `last ${days} days` : 'all transcripts'}. Estimates at API list prices.`,
    '',
    row('', 'Main', 'Subagents', 'Total'),
    row('Requests', String(main.requests), String(subagent.requests), String(main.requests + subagent.requests)),
    row('Total cost', usd(main.total), usd(subagent.total), usd(total)),
    row('Cache expiries after a wait', String(main.misses), String(subagent.misses), String(main.misses + subagent.misses)),
    row('Tokens rewritten', millions(main.rewritten), millions(subagent.rewritten), millions(main.rewritten + subagent.rewritten)),
    row('Extra cost of expiries', usd(main.expiry), usd(subagent.expiry), usd(expiry)),
    row('Share of total cost', percent(main.expiry, main.total), percent(subagent.expiry, subagent.total), percent(expiry, total)),
    '',
    'Simulated keepalive (not measured):',
    row('Wakes', String(main.wakes), String(subagent.wakes), String(main.wakes + subagent.wakes)),
    row('Keepalive cost', usd(main.wakeCost), usd(subagent.wakeCost), usd(main.wakeCost + subagent.wakeCost)),
    row('Expiry cost avoided', usd(main.avoided), usd(subagent.avoided), usd(main.avoided + subagent.avoided)),
    row('Net saving', usd(saved(main)), usd(saved(subagent)), usd(saved(main) + saved(subagent))),
    row('Net if sessions are abandoned', usd(saved(main) - main.abandonedWakeCost), usd(saved(subagent)), usd(saved(main) + saved(subagent) - main.abandonedWakeCost)),
    '',
    'Simulated total cost on a fixed cache lifetime. Every write pays that lifetime\'s price:',
    row('Everything on 5 minutes', usd(main.totalAt5m), usd(subagent.totalAt5m), usd(main.totalAt5m + subagent.totalAt5m)),
    row('Main 1 hour, subagents 5 minutes', usd(main.totalAt1h), usd(subagent.totalAt5m), usd(main.totalAt1h + subagent.totalAt5m)),
    row('Everything on 1 hour', usd(main.totalAt1h), usd(subagent.totalAt1h), usd(main.totalAt1h + subagent.totalAt1h)),
    '',
    'Assumes the same requests and pauses. Models without a listed price are skipped.',
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

module.exports = { parseTranscript, addTranscript, emptyTotals, priceFor, format };
