import 'dotenv/config';
import app from './api/app.js';

const REQUIRED_ENV = [
  'SARVAM_API_URL',
  'SARVAM_API_KEY',
  'SARVAM_CREATE_JOB_URL',
  'SARVAM_START_JOB_URL_TEMPLATE',
  'SARVAM_STATUS_URL_TEMPLATE',
  'SARVAM_DOWNLOAD_URL_TEMPLATE',
  'WEBHOOK_SECRET',
  'REDIS_URL'
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[api] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on ${port}`);
});
