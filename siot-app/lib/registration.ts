// 등록 코드 생성·검증 — 순수 함수, server-only 금지.
// 시옷플랫폼 연결 시 1회용 코드로 게이트웨이를 인증한다.
import { randomBytes } from "node:crypto";

/**
 * 8자리 대문자 16진수 등록 코드를 생성한다.
 * 사람이 입력하기 쉬운 형식 (예: "A3F2B1C9").
 */
export function generateCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

/**
 * 등록 코드의 유효성을 검증한다.
 * - code 또는 expiresAtIso가 null이면 false.
 * - nowIso가 expiresAtIso를 초과했으면 false (만료).
 * - 그 외: true (코드 일치 여부는 호출자가 별도 비교).
 */
export function isCodeValid(
  code: string | null,
  expiresAtIso: string | null,
  nowIso: string,
): boolean {
  if (!code || !expiresAtIso) return false;
  if (nowIso > expiresAtIso) return false;
  return true;
}
