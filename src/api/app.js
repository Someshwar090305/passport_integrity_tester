import express from 'express';
import jobsRouter from './routes/jobs.js';
import { apiKeyAuth, rateLimiter } from './middleware.js';
import { logger } from '../utils/logger.js';

const app = express();

// Global middleware — order matters: rate-limit first, then auth.
app.use(rateLimiter);
app.use(apiKeyAuth);

app.use('/api/v1/jobs', jobsRouter);

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  logger.error('Unhandled Express error', { status, message: err.message });
  res.status(status).json({
    status: 'error',
    message: err.message || 'Unexpected error'
  });
});

export default app;
