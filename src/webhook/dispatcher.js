import crypto from 'crypto';
import axios from 'axios';

export async function dispatch(callbackUrl, payload) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('WEBHOOK_SECRET is required');
  }

  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

  await axios.post(callbackUrl, payload, {
    headers: { 'X-Signature': `sha256=${sig}`, 'Content-Type': 'application/json' },
    timeout: 10000
  });
}
