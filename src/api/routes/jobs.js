import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulid';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { passportQueue } from '../../queue/passportQueue.js';
import { logger } from '../../utils/logger.js';

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png']);

// Temp directory for image buffers — keep images off Redis.
// Override with UPLOAD_TEMP_DIR if you want a specific path.
const UPLOAD_DIR = process.env.UPLOAD_TEMP_DIR || path.join(tmpdir(), 'passport_validator_uploads');

// Ensure the upload directory exists when the module loads.
await mkdir(UPLOAD_DIR, { recursive: true });

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

      // Write image buffers to disk so the job payload in Redis only carries
      // file paths instead of up-to-16 MB of base64 data per job.
      const frontExt = path.extname(front.originalname) || '.jpg';
      const backExt  = path.extname(back.originalname)  || '.jpg';
      const frontPath = path.join(UPLOAD_DIR, `${jobId}_front${frontExt}`);
      const backPath  = path.join(UPLOAD_DIR, `${jobId}_back${backExt}`);

      await Promise.all([
        writeFile(frontPath, front.buffer),
        writeFile(backPath,  back.buffer)
      ]);

      logger.info('Passport verification job enqueued', { job_id: jobId });

      await passportQueue.add(
        'verify-passport',
        {
          jobId,
          front: {
            path: frontPath,
            mimetype: front.mimetype,
            originalname: front.originalname
          },
          back: {
            path: backPath,
            mimetype: back.mimetype,
            originalname: back.originalname
          }
        },
        {
          jobId,
          // Retry up to 3 times with exponential backoff if the worker throws
          // (e.g. Vision API 429 or transient network error).
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 }
        }
      );

      return res.status(202).json({
        job_id: jobId,
        status: 'queued',
        message: 'Verification job accepted for background processing'
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/:jobId', async (req, res) => {
  const job = await passportQueue.getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      status: 'error',
      message: 'Job not found'
    });
  }

  const state = await job.getState();
  // job.returnvalue is a plain synchronous property in BullMQ — no await needed.
  const jobResult = job.returnvalue;

  if (state === 'completed') {
    return res.status(200).json(jobResult);
  }

  if (state === 'failed') {
    return res.status(500).json({
      job_id: req.params.jobId,
      status: 'failed',
      // job.failedReason holds the actual error message for failed jobs;
      // returnvalue is null in the failure case so it can never carry a message.
      message: job.failedReason || 'Job failed'
    });
  }

  return res.status(202).json({
    job_id: req.params.jobId,
    status: state,
    message: 'Job is still processing'
  });
});

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
