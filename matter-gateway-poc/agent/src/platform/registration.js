// 등록 코드 — siot-app lib/registration.ts 와 동일 (8자리 대문자 hex, 10분)
import { randomBytes } from 'node:crypto';
export const CODE_TTL_MS = 10 * 60 * 1000;
export function generateCode() { return randomBytes(4).toString('hex').toUpperCase(); }
export function isCodeValid(code, expiresAtIso, nowIso) {
  if (!code || !expiresAtIso) return false;
  if (nowIso > expiresAtIso) return false;
  return true;
}
