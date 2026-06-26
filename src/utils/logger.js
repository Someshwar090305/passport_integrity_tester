/**
 * Minimal structured JSON logger.
 *
 * Outputs one JSON object per line to stdout (info/warn/debug) or stderr (error).
 * Each entry contains:
 *   { time, level, msg, ...meta }
 *
 * This keeps the service observable without adding a runtime dependency. Swap
 * the internals for `pino` or `winston` at any time — callers use the same API.
 */

const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

// Honour LOG_LEVEL env var; default to 'info'.
const ACTIVE_LEVEL = LOG_LEVEL_RANK[process.env.LOG_LEVEL] ?? LOG_LEVEL_RANK.info;

function write(level, msg, meta = {}) {
  if ((LOG_LEVEL_RANK[level] ?? 0) < ACTIVE_LEVEL) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...meta
  };

  const line = JSON.stringify(entry) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta)
};
