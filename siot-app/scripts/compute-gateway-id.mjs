// 제조용 gatewayId 사전 계산 스크립트.
// 라즈베리파이 시리얼을 받아, 그 기기가 첫 부팅 시 생성할 gatewayId를 미리 출력한다.
// 용도: QR 라벨 인쇄 전 ID 확인. 실제 기기 결과와 반드시 일치해야 한다.
// 실행: node scripts/compute-gateway-id.mjs <pi-serial>
//        (Pi에서 직접 실행 시 인수 생략 가능 — /sys 또는 /proc/cpuinfo에서 자동 읽음)
import { v5 as uuidv5 } from "uuid";
import { readFileSync } from "node:fs";

// ⚠️ lib/gateway-id.ts의 SIOT_NAMESPACE와 반드시 동일해야 함.
// 이 값이 달라지면 계산된 gatewayId가 실제 기기와 달라져 QR 라벨이 무효화된다.
const SIOT_NAMESPACE = "6f1d2c9e-7a3b-5c4d-8e2f-1a2b3c4d5e6f";

/**
 * 라즈베리파이 시리얼 번호를 획득한다.
 * 우선순위:
 *   1. CLI 인수 (process.argv[2])
 *   2. /sys/firmware/devicetree/base/serial-number (Pi 전용 경로, NUL 문자 제거)
 *   3. /proc/cpuinfo의 "Serial" 행 파싱
 *   4. 모두 실패 → null 반환
 */
function getSerial() {
  // 1순위: CLI 인수
  const arg = process.argv[2];
  if (arg && arg.trim()) {
    return arg.trim();
  }

  // 2순위: Pi 전용 devicetree 경로 (NUL 문자 포함될 수 있으므로 제거 후 trim)
  try {
    const raw = readFileSync("/sys/firmware/devicetree/base/serial-number", "utf8");
    const serial = raw.replace(/\0/g, "").trim();
    if (serial) return serial;
  } catch {
    // 이 경로가 없는 환경(개발 PC 등)에서는 무시하고 다음 방법 시도
  }

  // 3순위: /proc/cpuinfo의 "Serial : <hex>" 행
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    const match = cpuinfo.match(/^Serial\s*:\s*(\w+)/m);
    if (match && match[1]) return match[1].trim();
  } catch {
    // /proc/cpuinfo도 없는 환경(Windows 등)에서는 무시
  }

  return null;
}

// ── 메인 처리 ──────────────────────────────────────────────────────────────

const serial = getSerial();

if (!serial) {
  // 시리얼을 어디서도 얻지 못한 경우 사용법 안내 후 종료
  console.error("오류: 시리얼 번호를 찾을 수 없습니다.");
  console.error("사용법: node scripts/compute-gateway-id.mjs <pi-serial>");
  console.error("  예시: node scripts/compute-gateway-id.mjs 100000001a2b3c4d");
  process.exit(1);
}

// lib/gateway-id.ts의 deriveGatewayId와 완전히 동일한 계산식:
//   "gw_" + uuidv5(serial, SIOT_NAMESPACE)
const id = "gw_" + uuidv5(serial, SIOT_NAMESPACE);

// mDNS 호스트명·URL 계산
// shortId = "gw_" 뒤 8자(slice(3,11)) → 게이트웨이 bonjour-service와 동일한 규칙
const shortId = id.slice(3, 11);
const hostname = `siot-${shortId}.local`;
const url = `http://${hostname}:3000`;

// 결과 출력
console.log(`gatewayId : ${id}`);
console.log(`serial    : ${serial}`);
console.log(`hostname  : ${hostname}`);
console.log(`url       : ${url}`);
console.log("→ 이 url을 QR로 라벨에 인쇄하면, 스캔 시 브라우저가 바로 이 게이트웨이를 엽니다(화면·IP·앱 불필요).");
