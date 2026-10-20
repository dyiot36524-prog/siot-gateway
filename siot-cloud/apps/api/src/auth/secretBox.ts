// 저장 비밀 암호화(웹훅 서명 비밀, 페어링 코드). relay 의 site_keys 와 같은 포맷:
// AES-256-GCM, 키 = SHA-256(UTF-8 DATA_ENC_KEY), 문자열 `v1.<iv12 b64url>.<ct b64url>.<tag16 b64url>`.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyOf = (encKey: string) => createHash('sha256').update(encKey, 'utf8').digest();

export function encryptSecret(plain: string, encKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(encKey), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

export function decryptSecret(enc: string, encKey: string): string {
  const [v, iv, ct, tag] = enc.split('.');
  if (v !== 'v1' || !iv || ct === undefined || !tag) throw new Error('unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', keyOf(encKey), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
