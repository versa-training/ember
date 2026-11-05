'use strict';

// One place that decides the cache lifetime, the wake interval, and the wake limit
// for each agent type. Every hook and scripts/check-env.js read it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INTERVAL_SEC = { '5m': 270, '1h': 3540 };
const DEFAULT_MAX_WAKES = 4;
const DEFAULT_SUBAGENT_TTL = '5m';
const DEFAULT_WAKE_MESSAGE =
  'ember keepalive: this turn only keeps the prompt cache warm. Reply with the single word ok. Do not use tools.';

const validTtl = (value) => (value === '5m' || value === '1h' ? value : null);

// Settings files, nearest first. A missing or malformed file is skipped.
function settingsFiles(cwd, home = os.homedir()) {
  const files = [];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'));
  files.push(path.join(home, '.claude', 'settings.json'));
  return files;
}

// First valid value of `key` in the settings files, with the file it came from.
function settingValue(key, cwd, home) {
  for (const file of settingsFiles(cwd, home)) {
    try {
      const value = validTtl(JSON.parse(fs.readFileSync(file, 'utf8'))?.[key]);
      if (value) return { value, file };
    } catch {
      // missing or malformed
    }
  }
  return null;
}

function forced(env) {
  return env.FORCE_PROMPT_CACHING_5M === '1' ? { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' } : null;
}

// An answer that needs no transcript: EMBER_MAIN_TTL or the force switch.
function explicitMainLifetime(env = process.env) {
  const fixed = forced(env);
  if (fixed) return fixed;
  const own = validTtl(env.EMBER_MAIN_TTL);
  return own ? { ttl: own, source: 'EMBER_MAIN_TTL' } : null;
}

// Main agent lifetime. `transcriptTtl` is the newest cache write in the transcript
// ('5m', '1h', or null). Returns { ttl, source } with ttl null when nothing says.
function mainLifetime({ env = process.env, cwd, home, transcriptTtl = null } = {}) {
  const explicit = explicitMainLifetime(env);
  if (explicit) return explicit;
  if (validTtl(transcriptTtl)) return { ttl: transcriptTtl, source: 'transcript' };
  const fromEnv = validTtl(env.CLAUDE_CODE_PROMPT_CACHE_TTL);
  if (fromEnv) return { ttl: fromEnv, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' };
  const setting = settingValue('promptCacheTtl', cwd, home);
  if (setting) return { ttl: setting.value, source: `promptCacheTtl in ${setting.file}` };
  return { ttl: null, source: 'unknown' };
}

function subagentLifetime({ env = process.env, cwd, home } = {}) {
  const fixed = forced(env);
  if (fixed) return fixed;
  const own = validTtl(env.EMBER_SUBAGENT_TTL);
  if (own) return { ttl: own, source: 'EMBER_SUBAGENT_TTL' };
  const fromEnv = validTtl(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL);
  if (fromEnv) return { ttl: fromEnv, source: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' };
  const setting = settingValue('subagentPromptCacheTtl', cwd, home);
  if (setting) return { ttl: setting.value, source: `subagentPromptCacheTtl in ${setting.file}` };
  return { ttl: DEFAULT_SUBAGENT_TTL, source: 'default' };
}

function nonNegativeInt(env, name) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Main agent wake interval in seconds. EMBER_MAIN_INTERVAL_SEC overrides exactly.
function mainInterval(ttl, env = process.env) {
  const override = nonNegativeInt(env, 'EMBER_MAIN_INTERVAL_SEC');
  if (override !== null) return { seconds: override, source: 'EMBER_MAIN_INTERVAL_SEC' };
  return { seconds: ttl ? INTERVAL_SEC[ttl] : null, source: ttl ? `lifetime ${ttl}` : 'unknown' };
}

// Subagent wait threshold in ms. EMBER_SUBAGENT_WAIT_MS overrides exactly.
function subagentWait(ttl, env = process.env) {
  const override = nonNegativeInt(env, 'EMBER_SUBAGENT_WAIT_MS');
  if (override !== null) return { ms: override, source: 'EMBER_SUBAGENT_WAIT_MS' };
  return { ms: INTERVAL_SEC[ttl] * 1000, source: `lifetime ${ttl}` };
}

function maxWakes(env = process.env) {
  const value = nonNegativeInt(env, 'EMBER_MAX_WAKES');
  return value === null ? { value: DEFAULT_MAX_WAKES, source: 'default' } : { value, source: 'EMBER_MAX_WAKES' };
}

function wakeMessage(env = process.env) {
  return env.EMBER_WAKE_MESSAGE ? env.EMBER_WAKE_MESSAGE : DEFAULT_WAKE_MESSAGE;
}

module.exports = {
  INTERVAL_SEC, DEFAULT_MAX_WAKES, DEFAULT_WAKE_MESSAGE, settingsFiles, explicitMainLifetime, mainLifetime,
  subagentLifetime, mainInterval, subagentWait, maxWakes, wakeMessage,
};
