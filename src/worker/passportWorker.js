/**
 * BullMQ worker entry point.
 *
 * This file only handles process startup (env check) and BullMQ event wiring.
 * All job processing logic lives in jobProcessor.js and is fully unit-testable
 * without starting this file.
 */

import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../queue/passportQueue.js';
import { processPassportJob, cleanupTempFiles } from './jobProcessor.js';
import { logger } from '../utils/logger.js';

const REQUIRED_ENV = ['GOOGLE_APPLICATION_CREDENTIALS'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  logger.error('Missing required environment variables', { missing: missingEnv });
  process.exit(1);
}

const worker = new Worker(
  'passport-validation',
  (job) => processPassportJob(job),
  { connection: redisConnection }
);

worker.on('completed', async (job) => {
  logger.info('Worker: job completed', { job_id: job.data?.jobId, bq_id: job.id });
  // Delete temp image files now that the job is fully done.
  const { front, back } = job.data || {};
  if (front?.path || back?.path) {
    await cleanupTempFiles([front?.path, back?.path].filter(Boolean));
  }
});

worker.on('failed', async (job, err) => {
  logger.error('Worker: job failed', {
    job_id: job?.data?.jobId,
    bq_id:  job?.id,
    attempt: job?.attemptsMade,
    error:   err?.message
  });
  // Only clean up temp files once all retries are exhausted so that retry
  // attempts can still read the image files from disk.
  if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    const { front, back } = job.data || {};
    if (front?.path || back?.path) {
      await cleanupTempFiles([front?.path, back?.path].filter(Boolean));
    }
  }
});
