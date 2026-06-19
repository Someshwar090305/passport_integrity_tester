import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../queue/passportQueue.js';
import { extractPassportData } from '../providers/ocrClient.js';
import { runValidation } from '../services/validationEngine.js';

const REQUIRED_ENV = ['GOOGLE_APPLICATION_CREDENTIALS'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[worker] Missing required env vars: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const worker = new Worker(
  'passport-validation',
  async (job) => {
    const { jobId, front, back } = job.data;
    const queueWaitMs = Math.max(0, (job.processedOn || Date.now()) - job.timestamp);

    const extractionStart = Date.now();
    const ocrResult = await extractPassportData(
      {
        mimetype: front.mimetype,
        originalname: front.originalname,
        dataBase64: front.dataBase64
      },
      {
        mimetype: back.mimetype,
        originalname: back.originalname,
        dataBase64: back.dataBase64
      }
    );

    const sdkExtractionMs = Date.now() - extractionStart;
    const validationStart = Date.now();
    const validation = runValidation(ocrResult);
    const internalValidationMs = Date.now() - validationStart;

    return {
      job_id: jobId,
      processing_metrics: {
        queue_wait_ms: queueWaitMs,
        sdk_extraction_ms: sdkExtractionMs,
        internal_validation_ms: internalValidationMs
      },
      verification_status: validation.verificationStatus,
      integrity_flags: validation.integrityFlags,
      extracted_data: validation.extractedData,
      extracted_features: validation.extractedFeatures,
      google_ocr_raw: ocrResult.raw
    };
  },
  { connection: redisConnection }
);

worker.on('completed', (job) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] completed job ${job.id}`);
});

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker] failed job ${job?.id}`, err);
});
