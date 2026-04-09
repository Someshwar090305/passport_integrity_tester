import { Queue } from 'bullmq';
import { connection } from './connection.js';
import { PASSPORT_QUEUE_NAME } from './constants.js';

export { PASSPORT_QUEUE_NAME };


export const passportQueue = new Queue(PASSPORT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: 500,
    removeOnFail: 1000
  }
});