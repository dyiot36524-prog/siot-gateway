// 릴레이·바인딩 비밀값: 게이트웨이 토큰(해시만 저장), claimSecret(라벨), 세대 키 암호화, hello 서명 검증.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** gatewayToken = 32바이트 hex(64자) */
export function newGatewayToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: sha256Hex(token) };
}

/** 같은 길이 문자열을 상수 시간 비교(길이가 다르면 false) */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 제시된 토큰의 해시를 저장된 해시와 timing-safe 비교 */
export function tokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  return safeEqual(sha256Hex(token), storedHash);
}

/** claimSecret = HMAC-SHA256(LABEL_MASTER_KEY, gatewayId) 앞 16 hex (라벨 4-4-4-4) */
export function claimSecretFor(labelMasterKey: string, gatewayId: string): string {
  return createHmac('sha256', labelMasterKey).update(gatewayId, 'utf8').digest('hex').slice(0, 16);
}

/** 입력(하이픈·대소문자 허용) 정규화 후 timing-safe 비교 */
export function claimSecretMatches(labelMasterKey: string, gatewayId: string, input: string): boolean {
  const norm = input.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(norm)) return false;
  return safeEqual(norm, claimSecretFor(labelMasterKey, gatewayId));
}

// ---- DATA_ENC_KEY AES-256-GCM: "v1.<iv b64url>.<ct b64url>.<tag b64url>", 키 = SHA-256(UTF-8 DATA_ENC_KEY) ----
const encKey = (dataEncKey: string) => createHash('sha256').update(dataEncKey, 'utf8').digest();

export function encryptSecret(dataEncKey: string, plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(dataEncKey), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

export function decryptSecret(dataEncKey: string, enc: string): Buffer {
  const [v, iv, ct, tag] = enc.split('.');
  if (v !== 'v1' || !iv || ct === undefined || !tag) throw new Error('unsupported ciphertext format');
  const d = createDecipheriv('aes-256-gcm', encKey(dataEncKey), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
}

/** hello.sig = Ed25519(UTF-8(nonce)) base64url, pubkey = raw 32바이트 base64url */
export function verifyHelloSig(pubkeyB64url: string, nonce: string, sigB64url: string): boolean {
  try {
    const raw = Buffer.from(pubkeyB64url, 'base64url');
    const sig = Buffer.from(sigB64url, 'base64url');
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubkeyB64url }, format: 'jwk' });
    return verify(null, Buffer.from(nonce, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
