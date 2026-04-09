import express from 'express';
import jobsRouter from './routes/jobs.js';

const app = express();

app.use('/api/v1/jobs', jobsRouter);

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    status: 'error',
    message: err.message || 'Unexpected error'
  });
});

export default app;
