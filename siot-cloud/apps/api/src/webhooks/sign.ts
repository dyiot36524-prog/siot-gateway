// Siot-Signature: t=<unix초>,v1=<hex(HMAC-SHA256(secret, t + "." + rawBody))>, 허용 오차 300초.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

export function signPayload(secret: string, body: string, unixSec: number): string {
  const v1 = createHmac('sha256', secret).update(`${unixSec}.${body}`, 'utf8').digest('hex');
  return `t=${unixSec},v1=${v1}`;
}

export function verifySignature(secret: string, body: string, header: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSec - t) > WEBHOOK_SIGNATURE_TOLERANCE_SEC) return false;
  const expected = Buffer.from(signPayload(secret, body, t).slice(-64), 'hex');
  return timingSafeEqual(expected, Buffer.from(m[2]!, 'hex'));
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function generateWebhookSecret(): string {
  let s = 'whsec_';
  for (let i = 0; i < 32; i++) s += BASE62[randomInt(62)];
  return s;
}
