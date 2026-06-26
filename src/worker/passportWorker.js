import 'dotenv/config';
import { Worker } from 'bullmq';
import { readFile, unlink } from 'node:fs/promises';
import { redisConnection } from '../queue/passportQueue.js';
import { extractPassportData } from '../providers/ocrClient.js';
import { runValidation, selectValidationResult } from '../services/validationEngine.js';
import { shouldUseLlmFallback, runLlmFallback, buildFallbackTrace } from '../services/llmFallback.js';
import { logger } from '../utils/logger.js';

const REQUIRED_ENV = ['GOOGLE_APPLICATION_CREDENTIALS'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  logger.error('Missing required environment variables', { missing: missingEnv });
  process.exit(1);
}

/**
 * Attempts to delete the temporary image files written by the API route.
 * Failures are logged but do not propagate — a missed cleanup is non-fatal.
 *
 * @param {string[]} filePaths
 */
async function cleanupTempFiles(filePaths) {
  await Promise.allSettled(
    filePaths.map((p) =>
      unlink(p).catch((err) =>
        logger.warn('Failed to delete temp file', { path: p, error: err.message })
      )
    )
  );
}

const worker = new Worker(
  'passport-validation',
  async (job) => {
    const { jobId, front, back } = job.data;
    const queueWaitMs = Math.max(0, (job.processedOn || Date.now()) - job.timestamp);

    logger.info('Processing passport job', { job_id: jobId, attempt: job.attemptsMade + 1 });

    // Read image bytes from disk (the API route wrote them there to keep
    // Redis memory usage low — only file paths travel through the queue).
    const [frontBuffer, backBuffer] = await Promise.all([
      readFile(front.path),
      readFile(back.path)
    ]);

    const extractionStart = Date.now();
    const ocrResult = await extractPassportData(
      {
        mimetype: front.mimetype,
        originalname: front.originalname,
        dataBase64: frontBuffer.toString('base64')
      },
      {
        mimetype: back.mimetype,
        originalname: back.originalname,
        dataBase64: backBuffer.toString('base64')
      }
    );

    const sdkExtractionMs = Date.now() - extractionStart;
    const validationStart = Date.now();
    const validation = runValidation(ocrResult);
    const internalValidationMs = Date.now() - validationStart;

    logger.info('First-pass validation complete', {
      job_id: jobId,
      status: validation.verificationStatus,
      score: validation.integrityScore,
      sdk_extraction_ms: sdkExtractionMs,
      internal_validation_ms: internalValidationMs
    });

    let llmFallback = null;
    if (shouldUseLlmFallback(ocrResult, validation)) {
      logger.info('Triggering LLM fallback', { job_id: jobId, reason: 'first-pass was weak' });
      llmFallback = await runLlmFallback(ocrResult);
      logger.info('LLM fallback complete', {
        job_id: jobId,
        status: llmFallback?.status,
        model: llmFallback?.model || null
      });
    }

    const llmStructured = llmFallback?.status === 'success' ? llmFallback.extracted.structured : null;

    const validationInput = {
      ...ocrResult,
      ...(llmStructured
        ? {
            passport_number: llmStructured.front.passport_number || ocrResult.passport_number,
            expiry_date: llmStructured.front.expiry_date || ocrResult.expiry_date,
            date_of_birth: llmStructured.front.date_of_birth || ocrResult.date_of_birth,
            file_number: llmStructured.back.file_number || ocrResult.file_number,
            address: llmStructured.back.address_block || ocrResult.address,
            front: {
              ...(ocrResult.front || {}),
              mrz_line1: llmStructured.mrz.line1 || ocrResult.front?.mrz_line1,
              mrz_line2: llmStructured.mrz.line2 || ocrResult.front?.mrz_line2,
              date_of_birth: llmStructured.front.date_of_birth || ocrResult.front?.date_of_birth,
              passport_number: llmStructured.front.passport_number || ocrResult.front?.passport_number,
              expiry_date: llmStructured.front.expiry_date || ocrResult.front?.expiry_date
            },
            back: {
              ...(ocrResult.back || {}),
              file_number: llmStructured.back.file_number || ocrResult.back?.file_number,
              address_block: llmStructured.back.address_block || ocrResult.back?.address_block
            },
            mrz: {
              ...(ocrResult.mrz || {}),
              line2: llmStructured.mrz.line2 || ocrResult.mrz?.line2,
              passportNumber: llmStructured.front.passport_number || ocrResult.mrz?.passportNumber
            }
          }
        : {})
    };

    const llmValidation = llmStructured ? runValidation(validationInput) : null;
    const effectiveValidation = selectValidationResult(validation, llmValidation);

    const mergedExtractedData = {
      ...effectiveValidation.extractedData,
      ...(llmFallback?.status === 'success'
        ? {
            passport_number:
              llmFallback.extracted.passport_number || effectiveValidation.extractedData.passport_number,
            date_of_birth:
              llmFallback.extracted.date_of_birth || effectiveValidation.extractedData.date_of_birth,
            expiry_date:
              llmFallback.extracted.expiry_date || effectiveValidation.extractedData.expiry_date,
            file_number:
              llmFallback.extracted.file_number || effectiveValidation.extractedData.file_number || null,
            parsed_address: {
              ...effectiveValidation.extractedData.parsed_address,
              ...(llmFallback.extracted.address
                ? { address_text: llmFallback.extracted.address }
                : {})
            }
          }
        : {})
    };

    const fallbackSummary =
      llmFallback?.status === 'success'
        ? {
            used: true,
            model: llmFallback?.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
          }
        : {
            used: false,
            reason: llmFallback?.message || null,
            retryable: llmFallback?.retryable || false
          };

    const fallbackTrace = llmFallback?.status === 'success'
      ? buildFallbackTrace(validation, llmFallback, effectiveValidation, validationInput)
      : null;

    logger.info('Job completed', {
      job_id: jobId,
      verification_status: effectiveValidation.verificationStatus,
      integrity_score: effectiveValidation.integrityScore,
      llm_used: fallbackSummary.used
    });

    return {
      job_id: jobId,
      processing_metrics: {
        queue_wait_ms: queueWaitMs,
        sdk_extraction_ms: sdkExtractionMs,
        internal_validation_ms: internalValidationMs
      },
      verification_status: effectiveValidation.verificationStatus,
      integrity_flags: effectiveValidation.integrityFlags,
      integrity_score: effectiveValidation.integrityScore,
      integrity_tier: effectiveValidation.integrityTier,
      review_required: effectiveValidation.reviewRequired,
      failed_checks: effectiveValidation.failedChecks,
      extracted_data: mergedExtractedData,
      extracted_features: {
        ...effectiveValidation.extractedFeatures,
        llm_fallback: fallbackSummary
      },
      google_ocr_raw: ocrResult.raw,
      llm_fallback: llmFallback,
      fallback_trace: fallbackTrace
    };
  },
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
    bq_id: job?.id,
    attempt: job?.attemptsMade,
    error: err?.message
  });
  // Only clean up temp files once the job has exhausted all retries.
  if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
    const { front, back } = job.data || {};
    if (front?.path || back?.path) {
      await cleanupTempFiles([front?.path, back?.path].filter(Boolean));
    }
  }
});
