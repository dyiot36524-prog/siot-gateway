// 게이트웨이 고유 식별자 도출 — 순수 함수, server-only 금지.
// 시리얼이 있으면 결정적(deterministic) UUID v5로, 없으면 무작위 UUID v4로 생성한다.
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";

/** 시옷 네임스페이스 UUID (고정값, 변경 금지). */
export const SIOT_NAMESPACE = "6f1d2c9e-7a3b-5c4d-8e2f-1a2b3c4d5e6f";

/**
 * 하드웨어 시리얼을 기반으로 게이트웨이 ID를 도출한다.
 * - serial이 truthy: 같은 serial → 항상 같은 ID (결정적).
 * - serial이 null/빈 문자열: 매 호출마다 새 무작위 ID.
 */
export function deriveGatewayId(serial: string | null): string {
  if (serial) {
    return "gw_" + uuidv5(serial, SIOT_NAMESPACE);
  }
  return "gw_" + uuidv4();
}

/**
 * 저장된 시리얼과 현재 하드웨어 시리얼을 비교해 재프로비저닝 여부를 판단한다.
 *
 * 두 값이 모두 비어있지 않고(truthy) 서로 다를 때만 true를 반환한다.
 * 그 외(둘 중 하나라도 null/빈값, 또는 동일)는 false를 반환한다.
 *
 * 보수적 판단 이유: 현재 시리얼을 읽지 못하는 환경(개발 PC, 컨테이너 등)에서
 * currentSerial이 null이 되는데, 이때 true를 반환하면 정상 기기가 불필요하게
 * 재프로비저닝되는 오탐(false positive)이 발생한다. 따라서 둘 다 확인 가능한
 * 경우에만 비교한다.
 */
export function shouldReprovision(
  storedSerial: string | null | undefined,
  currentSerial: string | null,
): boolean {
  // 어느 한쪽이라도 falsy(null, undefined, 빈 문자열)면 비교 불가 → 재프로비저닝 안 함.
  if (!storedSerial || !currentSerial) return false;
  // 둘 다 truthy이고 서로 다를 때만 SSD 복제로 판단.
  return storedSerial !== currentSerial;
}
