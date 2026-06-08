import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulid';
import { extractPassportData } from '../../providers/ocrClient.js';
import { runValidation } from '../../services/validationEngine.js';

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
