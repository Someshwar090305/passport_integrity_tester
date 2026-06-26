import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Optional API-key authentication
// ---------------------------------------------------------------------------
// Set API_KEY in your .env to enable. When the variable is absent the
// middleware is a no-op so existing integrations are not broken.
export function apiKeyAuth(req, res, next) {
  const expectedKey = process.env.API_KEY;
  if (!expectedKey) return next();            // auth not configured — allow all

  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== expectedKey) {
    logger.warn('Rejected request: missing or invalid API key', {
      ip: req.ip,
      path: req.path
    });
    return res.status(401).json({
      status: 'error',
      message: 'Missing or invalid API key. Provide it in the X-API-Key header.'
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter
// ---------------------------------------------------------------------------
// Defaults: 60 requests per IP per minute. Override via env:
//   RATE_LIMIT_WINDOW_MS — window duration in milliseconds (default 60 000)
//   RATE_LIMIT_MAX        — max requests per window (default 60)
//
// NOTE: This is a single-process in-memory store. If you run multiple API
// replicas behind a load balancer, replace this with a Redis-backed
// implementation (e.g. rate-limiter-flexible).
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX) || 60;

/** @type {Map<string, number[]>} */
const ipTimestamps = new Map();

// Periodically prune stale entries so the map does not grow unboundedly.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, times] of ipTimestamps) {
    const pruned = times.filter((t) => t > cutoff);
    if (pruned.length === 0) {
      ipTimestamps.delete(ip);
    } else {
      ipTimestamps.set(ip, pruned);
    }
  }
}, WINDOW_MS).unref(); // .unref() so this timer doesn't keep the process alive

export function rateLimiter(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  let timestamps = ipTimestamps.get(key) || [];
  timestamps = timestamps.filter((t) => t > windowStart);

  if (timestamps.length >= MAX_REQUESTS) {
    logger.warn('Rate limit exceeded', { ip: key, path: req.path });
    res.set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).json({
      status: 'error',
      message: 'Too many requests. Please slow down and try again.'
    });
  }

  timestamps.push(now);
  ipTimestamps.set(key, timestamps);
  next();
}
