import 'dotenv/config';
import app from './api/app.js';
import { logger } from './utils/logger.js';

const REQUIRED_ENV = ['GOOGLE_APPLICATION_CREDENTIALS'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  logger.error('Missing required environment variables', { missing });
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  logger.info('API server started', { port });
});
