/**
 * Pure job-processing logic for passport validation jobs.
 *
 * Separated from passportWorker.js so it can be imported and tested without
 * starting a BullMQ Worker or requiring a live Redis connection. All I/O and
 * service calls are injectable via the `deps` parameter, making the function
 * fully unit-testable with plain mock objects.
 */

import { readFile, unlink } from 'node:fs/promises';
import { extractPassportData } from '../providers/ocrClient.js';
import { runValidation, selectValidationResult } from '../services/validationEngine.js';
import {
  shouldUseLlmFallback,
  runLlmFallback,
  buildFallbackTrace
} from '../services/llmFallback.js';
import { assessOcrImageQuality } from '../services/imageQuality.js';
import { logger } from '../utils/logger.js';

/**
 * Attempts to delete temporary image files written by the API route.
 * Failures are logged but do not propagate — a missed cleanup is non-fatal.
 *
 * @param {string[]} filePaths
 */
export async function cleanupTempFiles(filePaths) {
  await Promise.allSettled(
    filePaths.map((p) =>
      unlink(p).catch((err) =>
        logger.warn('Failed to delete temp file', { path: p, error: err.message })
      )
    )
  );
}

/**
 * Processes a single passport-validation BullMQ job.
 *
 * @param {object} job - BullMQ job object. Expected shape:
 *   { data: { jobId, front: { path, mimetype, originalname },
 *             back:  { path, mimetype, originalname } },
 *     timestamp, processedOn, attemptsMade }
 *
 * @param {object} deps - Injectable dependencies (all optional; real
 *   implementations are used by default).
 * @param {Function} deps.readFileFn            - Reads a file path → Buffer
 * @param {Function} deps.extractPassportDataFn - OCR extraction
 * @param {Function} deps.runValidationFn       - Deterministic validation
 * @param {Function} deps.selectValidationResultFn - Picks the better result
 * @param {Function} deps.shouldUseLlmFallbackFn   - LLM trigger predicate
 * @param {Function} deps.runLlmFallbackFn         - LLM extraction
 * @param {Function} deps.buildFallbackTraceFn      - Builds the diff trace
 * @param {Function} deps.assessOcrImageQualityFn   - Post-OCR image quality gate
 *
 * @returns {Promise<object>} Structured validation result stored by BullMQ.
 */
export async function processPassportJob(job, {
  readFileFn             = readFile,
  extractPassportDataFn  = extractPassportData,
  runValidationFn        = runValidation,
  selectValidationResultFn = selectValidationResult,
  shouldUseLlmFallbackFn = shouldUseLlmFallback,
  runLlmFallbackFn       = runLlmFallback,
  buildFallbackTraceFn   = buildFallbackTrace,
  assessOcrImageQualityFn = assessOcrImageQuality
} = {}) {
  const { jobId, front, back } = job.data;
  const queueWaitMs = Math.max(0, (job.processedOn || Date.now()) - job.timestamp);

  logger.info('Processing passport job', { job_id: jobId, attempt: job.attemptsMade + 1 });

  // Read image bytes from disk (the API route wrote them there to keep Redis
  // memory usage low — only file paths travel through the queue).
  const [frontBuffer, backBuffer] = await Promise.all([
    readFileFn(front.path),
    readFileFn(back.path)
  ]);

  const extractionStart = Date.now();
  const ocrResult = await extractPassportDataFn(
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

  const imageQuality = assessOcrImageQualityFn(ocrResult);
  if (!imageQuality.acceptable) {
    logger.info('Job rejected: OCR image quality insufficient', {
      job_id: jobId,
      front_issues: imageQuality.front.issues,
      back_issues: imageQuality.back.issues
    });

    return {
      job_id: jobId,
      processing_metrics: {
        queue_wait_ms: queueWaitMs,
        sdk_extraction_ms: sdkExtractionMs,
        internal_validation_ms: 0
      },
      verification_status: 'REUPLOAD_REQUIRED',
      integrity_score: null,
      integrity_tier: null,
      review_required: false,
      failed_checks: [],
      integrity_flags: null,
      extracted_data: null,
      extracted_features: {
        image_quality: imageQuality,
        llm_fallback: { used: false, reason: 'skipped_due_to_image_quality', retryable: false }
      },
      image_quality: imageQuality,
      user_message: imageQuality.user_message,
      google_ocr_raw: ocrResult.raw,
      llm_fallback: null,
      fallback_trace: null
    };
  }

  const validationStart = Date.now();
  const validation = runValidationFn(ocrResult);
  const internalValidationMs = Date.now() - validationStart;

  logger.info('First-pass validation complete', {
    job_id: jobId,
    status: validation.verificationStatus,
    score: validation.integrityScore,
    sdk_extraction_ms: sdkExtractionMs,
    internal_validation_ms: internalValidationMs
  });

  // ── LLM fallback ──────────────────────────────────────────────────────────
  let llmFallback = null;
  if (shouldUseLlmFallbackFn(ocrResult, validation)) {
    logger.info('Triggering LLM fallback', { job_id: jobId, reason: 'first-pass was weak' });
    llmFallback = await runLlmFallbackFn(ocrResult);
    logger.info('LLM fallback complete', {
      job_id: jobId,
      status: llmFallback?.status,
      model: llmFallback?.model || null
    });
  }

  const llmStructured = llmFallback?.status === 'success'
    ? llmFallback.extracted.structured
    : null;

  // Build the input for the second-pass validation, merging LLM corrections
  // over the original OCR result where available.
  const validationInput = {
    ...ocrResult,
    ...(llmStructured
      ? {
          passport_number: llmStructured.front.passport_number || ocrResult.passport_number,
          expiry_date:     llmStructured.front.expiry_date     || ocrResult.expiry_date,
          date_of_birth:   llmStructured.front.date_of_birth   || ocrResult.date_of_birth,
          file_number:     llmStructured.back.file_number      || ocrResult.file_number,
          address:         llmStructured.back.address_block    || ocrResult.address,
          front: {
            ...(ocrResult.front || {}),
            mrz_line1:       llmStructured.mrz.line1                || ocrResult.front?.mrz_line1,
            mrz_line2:       llmStructured.mrz.line2                || ocrResult.front?.mrz_line2,
            date_of_birth:   llmStructured.front.date_of_birth      || ocrResult.front?.date_of_birth,
            passport_number: llmStructured.front.passport_number    || ocrResult.front?.passport_number,
            expiry_date:     llmStructured.front.expiry_date        || ocrResult.front?.expiry_date
          },
          back: {
            ...(ocrResult.back || {}),
            file_number:   llmStructured.back.file_number   || ocrResult.back?.file_number,
            address_block: llmStructured.back.address_block || ocrResult.back?.address_block
          },
          mrz: {
            ...(ocrResult.mrz || {}),
            line2:          llmStructured.mrz.line2                || ocrResult.mrz?.line2,
            passportNumber: llmStructured.front.passport_number    || ocrResult.mrz?.passportNumber
          }
        }
      : {})
  };

  const llmValidation = llmStructured ? runValidationFn(validationInput) : null;
  const effectiveValidation = selectValidationResultFn(validation, llmValidation);

  // ── Merge extracted data ──────────────────────────────────────────────────
  const mergedExtractedData = {
    ...effectiveValidation.extractedData,
    ...(llmFallback?.status === 'success'
      ? {
          passport_number:
            llmFallback.extracted.passport_number || effectiveValidation.extractedData.passport_number,
          date_of_birth:
            llmFallback.extracted.date_of_birth   || effectiveValidation.extractedData.date_of_birth,
          expiry_date:
            llmFallback.extracted.expiry_date      || effectiveValidation.extractedData.expiry_date,
          file_number:
            llmFallback.extracted.file_number      || effectiveValidation.extractedData.file_number || null,
          parsed_address: {
            ...effectiveValidation.extractedData.parsed_address,
            ...(llmFallback.extracted.address
              ? { address_text: llmFallback.extracted.address }
              : {})
          }
        }
      : {})
  };

  const fallbackSummary = llmFallback?.status === 'success'
    ? {
        used:  true,
        model: llmFallback?.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
      }
    : {
        used:      false,
        reason:    llmFallback?.message  || null,
        retryable: llmFallback?.retryable || false
      };

  const fallbackTrace = llmFallback?.status === 'success'
    ? buildFallbackTraceFn(validation, llmFallback, effectiveValidation, validationInput)
    : null;

  logger.info('Job completed', {
    job_id: jobId,
    verification_status: effectiveValidation.verificationStatus,
    integrity_score:     effectiveValidation.integrityScore,
    llm_used:            fallbackSummary.used
  });

  return {
    job_id: jobId,
    processing_metrics: {
      queue_wait_ms:        queueWaitMs,
      sdk_extraction_ms:    sdkExtractionMs,
      internal_validation_ms: internalValidationMs
    },
    verification_status: effectiveValidation.verificationStatus,
    integrity_flags:     effectiveValidation.integrityFlags,
    integrity_score:     effectiveValidation.integrityScore,
    integrity_tier:      effectiveValidation.integrityTier,
    review_required:     effectiveValidation.reviewRequired,
    failed_checks:       effectiveValidation.failedChecks,
    extracted_data:      mergedExtractedData,
    extracted_features: {
      ...effectiveValidation.extractedFeatures,
      llm_fallback: fallbackSummary
    },
    google_ocr_raw: ocrResult.raw,
    llm_fallback:   llmFallback,
    fallback_trace: fallbackTrace
  };
}
