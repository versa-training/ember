'use strict';

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
  return process.env.WARMCACHE_STATE_DIR || path.join(os.tmpdir(), 'warmcache');
}

function statePath(sessionId) {
  return path.join(stateDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return { generation: 0, wakes: 0 };
  }
}

function writeState(sessionId, state) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const target = statePath(sessionId);
  const temporary = `${target}.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

// Returns '1h', '5m', or null from the newest cache write in the transcript tail.
function lastCacheTtl(transcriptPath) {
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
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const creation = entry?.message?.usage?.cache_creation;
    if (!creation) continue;
    if (creation.ephemeral_1h_input_tokens > 0) return '1h';
    if (creation.ephemeral_5m_input_tokens > 0) return '5m';
  }
  return null;
}

module.exports = { readStdin, intEnv, isOff, readState, writeState, lastCacheTtl };
