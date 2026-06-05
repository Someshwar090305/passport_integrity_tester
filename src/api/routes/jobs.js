import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulid';
import { passportQueue } from '../../queue/passportQueue.js';
import { extractPassportData } from '../../providers/ocrClient.js';
import { runValidation } from '../../services/validationEngine.js';

// SSRF guard: reject callback URLs pointing at private/loopback/link-local ranges
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,     // link-local / AWS metadata
  /^::1$/,           // IPv6 loopback
  /^fc00:/i,         // IPv6 ULA
  /^fe80:/i          // IPv6 link-local
];

function isCallbackUrlSafe(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(host))) return false;
  return true;
}

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      cb(new Error('Only image/jpeg and image/png are allowed'));
      return;
    }
    cb(null, true);
  }
});

const router = Router();

router.post(
  '/verify-passport',
  upload.fields([
    { name: 'front_image', maxCount: 1 },
    { name: 'back_image', maxCount: 1 }
  ]),
  async (req, res, next) => {
    try {
      const callbackUrl = req.body?.callback_url;
      if (!callbackUrl) {
        return res.status(400).json({ status: 'error', message: 'callback_url is required' });
      }
      if (!isCallbackUrlSafe(callbackUrl)) {
        return res.status(400).json({
          status: 'error',
          message: 'callback_url must be a valid http/https URL pointing to a public host'
        });
      }

      const front = req.files?.front_image?.[0];
      const back = req.files?.back_image?.[0];
      if (!front || !back) {
        return res.status(400).json({
          status: 'error',
          message: 'front_image and back_image are required'
        });
      }

      const jobId = `job_${ulid()}`;

      await passportQueue.add(
        'verify-passport',
        {
          callbackUrl,
          frontImage: {
            mimetype: front.mimetype,
            originalname: front.originalname,
            dataBase64: front.buffer.toString('base64')
          },
          backImage: {
            mimetype: back.mimetype,
            originalname: back.originalname,
            dataBase64: back.buffer.toString('base64')
          }
        },
        { jobId }
      );

      return res.status(202).json({
        status: 'processing',
        job_id: jobId,
        message: 'Images buffered and queued. Results will be posted to the callback URL.'
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/verify-passport-sync',
  upload.fields([
    { name: 'front_image', maxCount: 1 },
    { name: 'back_image', maxCount: 1 }
  ]),
  async (req, res, next) => {
    try {
      const front = req.files?.front_image?.[0];
      const back = req.files?.back_image?.[0];
      if (!front || !back) {
        return res.status(400).json({
          status: 'error',
          message: 'front_image and back_image are required'
        });
      }

      const jobId = `job_${ulid()}`;
      const extractionStart = Date.now();

      const ocrResult = await extractPassportData(
        {
          mimetype: front.mimetype,
          originalname: front.originalname,
          dataBase64: front.buffer.toString('base64')
        },
        {
          mimetype: back.mimetype,
          originalname: back.originalname,
          dataBase64: back.buffer.toString('base64')
        }
      );

      const sdkExtractionMs = Date.now() - extractionStart;

      const validationStart = Date.now();
      const validation = runValidation(ocrResult);
      const internalValidationMs = Date.now() - validationStart;

      const payload = {
        job_id: jobId,
        processing_metrics: {
          queue_wait_ms: 0,
          sdk_extraction_ms: sdkExtractionMs,
          internal_validation_ms: internalValidationMs
        },
        verification_status: validation.verificationStatus,
        integrity_flags: validation.integrityFlags,
        extracted_data: validation.extractedData,
        extracted_features: validation.extractedFeatures
      };

      return res.status(200).json(payload);
    } catch (error) {
      return next(error);
    }
  }
);

router.use((error, _req, res, next) => {
  if (!(error instanceof multer.MulterError) && !error.message) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ status: 'error', message: 'File size exceeds 8MB limit' });
    return;
  }

  res.status(400).json({ status: 'error', message: error.message });
});

export default router;
