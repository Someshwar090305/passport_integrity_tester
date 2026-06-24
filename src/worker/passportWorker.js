import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../queue/passportQueue.js';
import { extractPassportData } from '../providers/ocrClient.js';
import { runValidation, selectValidationResult } from '../services/validationEngine.js';
import { shouldUseLlmFallback, runLlmFallback, buildFallbackTrace } from '../services/llmFallback.js';

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

    let llmFallback = null;
    if (shouldUseLlmFallback(ocrResult, validation)) {
      llmFallback = await runLlmFallback(ocrResult);
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
            model: llmFallback?.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
          }
        : {
            used: false,
            reason: llmFallback?.message || null,
            retryable: llmFallback?.retryable || false
          };

    const fallbackTrace = llmFallback?.status === 'success'
      ? buildFallbackTrace(validation, llmFallback, effectiveValidation, validationInput)
      : null;

    return {
      job_id: jobId,
      processing_metrics: {
        queue_wait_ms: queueWaitMs,
        sdk_extraction_ms: sdkExtractionMs,
        internal_validation_ms: internalValidationMs
      },
      verification_status: effectiveValidation.verificationStatus,
      integrity_flags: effectiveValidation.integrityFlags,
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

worker.on('completed', (job) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] completed job ${job.id}`);
});

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker] failed job ${job?.id}`, err);
});
