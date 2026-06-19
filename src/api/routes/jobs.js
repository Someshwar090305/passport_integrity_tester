import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulid';
import { passportQueue } from '../../queue/passportQueue.js';

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
      await passportQueue.add(
        'verify-passport',
        {
          jobId,
          front: {
            mimetype: front.mimetype,
            originalname: front.originalname,
            dataBase64: front.buffer.toString('base64')
          },
          back: {
            mimetype: back.mimetype,
            originalname: back.originalname,
            dataBase64: back.buffer.toString('base64')
          }
        },
        { jobId }
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
  const jobResult = await job.returnvalue;

  if (state === 'completed') {
    return res.status(200).json(jobResult);
  }

  if (state === 'failed') {
    return res.status(500).json({
      job_id: req.params.jobId,
      status: 'failed',
      message: jobResult?.message || 'Job failed'
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
