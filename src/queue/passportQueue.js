import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null
});

export const passportQueue = new Queue('passport-validation', {
  connection: redisConnection
});
