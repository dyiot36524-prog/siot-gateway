// 시옷플랫폼 → 시옷앱 호출 인증.
// v0.2: 게이트웨이별 토큰을 스토어에서 읽는다. 없으면 dev 환경변수 폴백.
import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getOrCreateGatewayId } from "./gateway-identity";
import { loadStore } from "./gateway-store";

export interface AuthResult {
  ok: boolean;
  gatewayId?: string;
  error?: string;
}

/**
 * 이 게이트웨이의 식별자를 반환한다.
 * - SIOT_GATEWAY_ID 환경변수가 있으면 dev 오버라이드로 사용.
 * - 없으면 스토어/하드웨어 시리얼에서 생성 또는 로드.
 */
export async function getGatewayId(): Promise<string> {
  if (process.env.SIOT_GATEWAY_ID) {
    return process.env.SIOT_GATEWAY_ID;
  }
  return getOrCreateGatewayId();
}

/** 타이밍 공격에 안전한 문자열 비교. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 플랫폼 토큰을 검증한다.
 * - 헤더: `Authorization: Bearer <token>`
 * - 또는 쿼리: `?token=<token>` (SSE/EventSource용 — 헤더를 못 보낼 때)
 * 기대 토큰은 스토어의 gatewayToken 우선, 없으면 SIOT_PLATFORM_TOKEN 환경변수(dev).
 */
export async function verifyPlatformAuth(request: Request): Promise<AuthResult> {
  const store = await loadStore();
  const expected = store.gatewayToken ?? process.env.SIOT_PLATFORM_TOKEN;

  if (!expected) {
    return {
      ok: false,
      error: "미등록 게이트웨이입니다. 먼저 등록(/connect)하세요.",
    };
  }

  const header = request.headers.get("authorization");
  let token: string | null = null;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length).trim();
  }
  if (!token) {
    token = new URL(request.url).searchParams.get("token");
  }
  if (!token) {
    return { ok: false, error: "인증 토큰이 없습니다 (Authorization: Bearer 또는 ?token=)." };
  }
  if (!safeEqual(token, expected)) {
    return { ok: false, error: "유효하지 않은 토큰입니다." };
  }

  const gatewayId = await getGatewayId();
  return { ok: true, gatewayId };
}

/** 인증 실패 시 표준 401 JSON 응답. */
export function unauthorized(error: string): Response {
  return Response.json({ ok: false, error }, { status: 401 });
}
