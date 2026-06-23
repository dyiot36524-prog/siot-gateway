// 페어링 프로토콜 분류 로직. (순수 함수 — server-only 금지)
// 네트워크/HA 호출 없음 → 단위 테스트로 검증 가능.

/** 지원하는 페어링 프로토콜 목록 (프론트 옵션 조회 + 유효성 검사용). */
export const SUPPORTED_PROTOCOLS = ["MATTER", "ZIGBEE", "DEMO"] as const;

/** SUPPORTED_PROTOCOLS 원소 유니온 타입. */
export type PairingProtocol = (typeof SUPPORTED_PROTOCOLS)[number];

/** Matter/Zigbee는 실물 하드웨어가 필요하므로 '미지원' 안내 메시지. */
const UNSUPPORTED_MESSAGE =
  "Matter/Zigbee 페어링은 실물 안테나/동글이 필요합니다 (골격).";

/**
 * 입력 문자열을 trim + toUpperCase 정규화 후 페어링 프로토콜로 분류한다.
 * - "DEMO"       → {kind:"demo"}
 * - "MATTER"/"ZIGBEE" → {kind:"unsupported", message}
 * - 그 외        → {kind:"invalid"}
 */
export function classifyProtocol(
  input: string,
): { kind: "demo" } | { kind: "unsupported"; message: string } | { kind: "invalid" } {
  const normalized = input.trim().toUpperCase();

  switch (normalized) {
    case "DEMO":
      return { kind: "demo" };
    case "MATTER":
    case "ZIGBEE":
      return { kind: "unsupported", message: UNSUPPORTED_MESSAGE };
    default:
      return { kind: "invalid" };
  }
}
