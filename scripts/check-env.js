#!/usr/bin/env node
'use strict';

// Prints what decides cache behavior on your computer: Claude Code version, whether
// the plugin manifest validates, the cache lifetime in recent transcripts, and
// relevant environment variables. Variables with secret-looking names are left out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTranscript, usageOf } = require('./cache-report');
const config = require('../hooks/ember-config');

const PLUGIN_ROOT = path.join(__dirname, '..');
const RELEVANT = /^(CLAUDE_CODE_|ANTHROPIC_|EMBER_|DISABLE_PROMPT_CACHING|ENABLE_PROMPT_CACHING)/;
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|BEARER/i;

function envLines(env) {
  const shown = [];
  const hidden = [];
  for (const name of Object.keys(env).sort()) {
    if (!RELEVANT.test(name)) continue;
    const value = env[name];
    if (SECRET.test(name) || /:\/\/[^/]*@/.test(value)) hidden.push(name);
    else shown.push(`${name}=${value}`);
  }
  return { shown, hidden };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 });
  return result.error ? { ok: false, text: String(result.error.message) } : { ok: result.status === 0, text: `${result.stdout}${result.stderr}`.trim() };
}

// Newest request with a cache write in transcripts changed in the last 2 days.
function recentLifetime(root, days = 2) {
  const since = Date.now() - days * 86400000;
  const requests = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of files) {
      try {
        const file = path.join(dir, name);
        if (fs.statSync(file).mtimeMs < since) continue;
        requests.push(...parseTranscript(fs.readFileSync(file, 'utf8')));
      } catch {
        // unreadable file
      }
    }
  }
  const writes = requests.map((request) => ({ time: request.time, use: usageOf(request) }))
    .filter((entry) => entry.use.write5m + entry.use.write1h > 0)
    .sort((a, b) => b.time - a.time);
  if (writes.length === 0) return null;
  const share1h = writes.reduce((t, e) => t + e.use.write1h, 0) / writes.reduce((t, e) => t + e.use.write5m + e.use.write1h, 0);
  return { newest: writes[0].use.write1h > 0 ? '1h' : '5m', newestAt: new Date(writes[0].time).toISOString(), count: writes.length, share1h };
}

// Resolved lifetime, interval, and wake limit per agent type, each with its source.
function resolvedLines(lifetime, env = process.env, cwd = process.cwd()) {
  const main = config.mainLifetime({ env, cwd, transcriptTtl: lifetime ? lifetime.newest : null });
  const configured = config.configuredMain({ env, cwd });
  const mainInterval = config.mainInterval(main.ttl, env);
  const wakes = config.maxWakes(env);
  const sub = config.subagentLifetime({ env, cwd });
  const wait = config.subagentWait(sub.ttl, env);
  return [
    'resolved by ember:',
    `  main agent lifetime: ${main.ttl ?? 'unknown (no wakes until a cache write shows it)'} (${main.source})`,
    ...(configured.ttl !== main.ttl
      ? [`  note: configuration says ${configured.ttl ?? 'nothing'} (${configured.source}) but the newest cache write in transcripts is ${lifetime ? lifetime.newest : 'absent'}; ember follows what happened`]
      : []),
    `  main agent wake interval: ${mainInterval.seconds ?? 'none'} seconds (${mainInterval.source})`,
    `  main agent wake limit: ${wakes.value} (${wakes.source})`,
    `  subagent lifetime: ${sub.ttl} (${sub.source})`,
    `  subagent hook: ${env.EMBER_SUBAGENT === '1' ? 'on' : 'off (EMBER_SUBAGENT=1 turns it on)'}`,
    `  subagent foreground Bash limit when on: ${wait.ms / 1000} seconds (${wait.source})`,
    `  subagent wake limit: not applicable, subagents are not woken`,
  ];
}

function main() {
  const version = run('claude', ['--version']);
  const validate = run('claude', ['plugin', 'validate', PLUGIN_ROOT]);
  const lifetime = recentLifetime(process.env.EMBER_TRANSCRIPT_ROOT || path.join(os.homedir(), '.claude', 'projects'));
  const { shown, hidden } = envLines(process.env);
  const out = [
    `date: ${new Date().toISOString()}`,
    `node: ${process.version}`,
    `claude code: ${version.ok ? version.text : `not found (${version.text})`}`,
    `plugin manifest validates: ${validate.ok ? 'yes' : `no or unknown (${validate.text.split('\n')[0]})`}`,
    lifetime
      ? `cache lifetime in transcripts of the last 2 days: newest write ${lifetime.newest} at ${lifetime.newestAt}; ${lifetime.count} writes, ${(lifetime.share1h * 100).toFixed(1)}% of written tokens at 1h`
      : 'cache lifetime in transcripts of the last 2 days: no cache writes found',
    ...resolvedLines(lifetime),
    'environment:',
    ...(shown.length ? shown.map((line) => `  ${line}`) : ['  none of the relevant variables are set']),
    ...(hidden.length ? [`  left out (secret-looking names): ${hidden.join(', ')}`] : []),
  ];
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { envLines, recentLifetime, resolvedLines };
