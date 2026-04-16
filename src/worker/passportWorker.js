import 'dotenv/config';
import { Worker, UnrecoverableError } from 'bullmq';
import { connection } from '../queue/connection.js';
import { PASSPORT_QUEUE_NAME } from '../queue/constants.js';
import { extractPassportData } from '../providers/sarvamClient.js';
import { runValidation } from '../services/validationEngine.js';
import { dispatch } from '../webhook/dispatcher.js';

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
  console.error(`[worker] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const worker = new Worker(
  PASSPORT_QUEUE_NAME,
  async (job) => {
    const queueWaitMs = Date.now() - job.timestamp;
    const extractionStart = Date.now();

    let ocrResult;
    try {
      ocrResult = await extractPassportData(job.data.frontImage, job.data.backImage);
    } catch (error) {
      throw new UnrecoverableError(`OCR extraction failed: ${error.message}`);
    }
    const sdkExtractionMs = Date.now() - extractionStart;

    const validationStart = Date.now();
    const validation = runValidation(ocrResult);
    const internalValidationMs = Date.now() - validationStart;

    const payload = {
      job_id: job.id,
      processing_metrics: {
        queue_wait_ms: queueWaitMs,
        sdk_extraction_ms: sdkExtractionMs,
        internal_validation_ms: internalValidationMs
      },
      verification_status: validation.verificationStatus,
      integrity_flags: validation.integrityFlags,
      extracted_data: validation.extractedData,
      extracted_features: validation.extractedFeatures
    };

    try {
      await dispatch(job.data.callbackUrl, payload);
      return payload;
    } catch (error) {
      const status = error.response?.status;
      // Webhook providers commonly rate-limit with 429. Treat it as retryable
      // so BullMQ can apply its configured exponential backoff attempts.
      if (status === 429) {
        throw error;
      }
      if (status && status < 500) {
        throw new UnrecoverableError(`Webhook rejected request: ${error.message}`);
      }
      throw error;
    }
  },
  { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 4) }
);

worker.on('completed', (job) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] completed ${job.id}`);
});

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker] failed ${job?.id}: ${err.message}`);
});

// eslint-disable-next-line no-console
console.log('[worker] passport worker started');
