'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TAIL_BYTES = 512 * 1024;

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isOff(name) {
  return process.env[name] === '0';
}

function stateDir() {
  return process.env.WARMCACHE_STATE_DIR || path.join(os.homedir(), '.claude', 'warmcache');
}

// Creates the state directory with mode 0700 and returns its path, or null when it
// is not a real directory (not a symlink) owned by this user. Null means no state,
// and callers do nothing.
function ensureStateDir() {
  const dir = stateDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
    return dir;
  } catch {
    return null;
  }
}

function statePath(dir, sessionId) {
  return path.join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

// Returns the stored state, defaults when none is valid, or null when the state
// directory cannot be trusted.
function readState(sessionId) {
  const defaults = { generation: 0, wakes: 0 };
  const dir = ensureStateDir();
  if (!dir) return null;
  try {
    const file = fs.openSync(statePath(dir, sessionId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } finally {
      fs.closeSync(file);
    }
    if (!nonNegativeInteger(parsed?.generation) || !nonNegativeInteger(parsed?.wakes)) return defaults;
    const state = { generation: parsed.generation, wakes: parsed.wakes };
    if (Number.isFinite(parsed.pendingWakeAt)) state.pendingWakeAt = parsed.pendingWakeAt;
    return state;
  } catch {
    return defaults;
  }
}

// Returns true when the state was stored.
function writeState(sessionId, state) {
  const dir = ensureStateDir();
  if (!dir) return false;
  const target = statePath(dir, sessionId);
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // nothing to remove
    }
    return false;
  }
}

// Scans the transcript tail from the newest line. Returns the cache lifetime of the
// newest cache write ('1h', '5m', or null) and the time in ms of the newest usage entry.
function transcriptTail(transcriptPath) {
  let text;
  try {
    const { size } = fs.statSync(transcriptPath);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const file = fs.openSync(transcriptPath, 'r');
    fs.readSync(file, buffer, 0, length, size - length);
    fs.closeSync(file);
    text = buffer.toString('utf8');
  } catch {
    return { ttl: null, newestMs: null };
  }
  let ttl = null;
  let newestMs = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (!usage) continue;
    const time = Date.parse(entry.timestamp);
    if (newestMs === null && Number.isFinite(time)) newestMs = time;
    const creation = usage.cache_creation;
    if (!creation || ttl) continue;
    if (creation.ephemeral_1h_input_tokens > 0) ttl = '1h';
    else if (creation.ephemeral_5m_input_tokens > 0) ttl = '5m';
    if (ttl && newestMs !== null) break;
  }
  return { ttl, newestMs };
}

function lastCacheTtl(transcriptPath) {
  return transcriptTail(transcriptPath).ttl;
}

module.exports = { readStdin, intEnv, isOff, ensureStateDir, readState, writeState, lastCacheTtl, transcriptTail };
