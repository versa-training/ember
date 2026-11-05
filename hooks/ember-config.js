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

const MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';

// Settings files in the order Claude Code ranks them: managed, then the nearest
// project file, then the user file. Read again on every call, never cached.
function settingsFiles(cwd, home = os.homedir(), managed = MANAGED_SETTINGS) {
  const files = [managed];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'));
  files.push(path.join(home, '.claude', 'settings.json'));
  return files;
}

function readSettings(cwd, home, managed) {
  const out = [];
  for (const file of settingsFiles(cwd, home, managed)) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && typeof json === 'object' && !Array.isArray(json)) out.push({ file, json });
    } catch {
      // missing or malformed
    }
  }
  return out;
}

// First valid value of an env variable: the process env, then the env block of each settings file.
function envValue(name, env, files) {
  const own = validTtl(env[name]);
  if (own) return { value: own, source: name };
  for (const { file, json } of files) {
    const value = validTtl(json.env?.[name]);
    if (value) return { value, source: `${name} in env block of ${file}` };
  }
  return null;
}

function settingValue(key, files) {
  for (const { file, json } of files) {
    const value = validTtl(json[key]);
    if (value) return { value, source: `${key} in ${file}` };
  }
  return null;
}

// The two Claude Code controls for one bucket, then the hour switch shared by both.
function fromConfig({ envName, settingKey, env, cwd, home, managed }) {
  const files = readSettings(cwd, home, managed);
  const fromEnv = envValue(envName, env, files);
  if (fromEnv) return { ttl: fromEnv.value, source: fromEnv.source };
  const fromSetting = settingValue(settingKey, files);
  if (fromSetting) return { ttl: fromSetting.value, source: fromSetting.source };
  const hour = [env.ENABLE_PROMPT_CACHING_1H, ...files.map(({ json }) => json.env?.ENABLE_PROMPT_CACHING_1H)].find((v) => v === '1' || v === 1);
  if (hour !== undefined) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' };
  return null;
}

const forced = (env) => (env.FORCE_PROMPT_CACHING_5M === '1' ? { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' } : null);

// An answer that needs no transcript: the EMBER_MAIN_TTL test override.
function explicitMainLifetime(env = process.env) {
  const own = validTtl(env.EMBER_MAIN_TTL);
  return own ? { ttl: own, source: 'EMBER_MAIN_TTL' } : null;
}

// What the settings and environment say for the main agent, without the transcript.
function configuredMain({ env = process.env, cwd, home, managed } = {}) {
  return forced(env) ?? fromConfig({ envName: 'CLAUDE_CODE_PROMPT_CACHE_TTL', settingKey: 'promptCacheTtl', env, cwd, home, managed })
    ?? { ttl: null, source: 'unknown (the default depends on your plan)' };
}

// Main agent lifetime. Order: EMBER_MAIN_TTL, the newest cache write in the transcript
// (it is what happened), then the configuration. transcriptTtl is '5m', '1h', or null.
function mainLifetime({ env = process.env, cwd, home, managed, transcriptTtl = null } = {}) {
  const explicit = explicitMainLifetime(env);
  if (explicit) return explicit;
  if (validTtl(transcriptTtl)) return { ttl: transcriptTtl, source: 'transcript' };
  return configuredMain({ env, cwd, home, managed });
}

function subagentLifetime({ env = process.env, cwd, home, managed } = {}) {
  const own = validTtl(env.EMBER_SUBAGENT_TTL);
  if (own) return { ttl: own, source: 'EMBER_SUBAGENT_TTL' };
  return forced(env)
    ?? fromConfig({ envName: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', settingKey: 'subagentPromptCacheTtl', env, cwd, home, managed })
    ?? { ttl: DEFAULT_SUBAGENT_TTL, source: 'default' };
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
  INTERVAL_SEC, DEFAULT_MAX_WAKES, DEFAULT_WAKE_MESSAGE, MANAGED_SETTINGS, settingsFiles, explicitMainLifetime, configuredMain, mainLifetime,
  subagentLifetime, mainInterval, subagentWait, maxWakes, wakeMessage,
};
