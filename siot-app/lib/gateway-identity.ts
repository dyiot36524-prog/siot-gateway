// 게이트웨이 하드웨어 시리얼 읽기 + 영속 ID 관리 — server-only.
// 라즈베리파이의 하드웨어 시리얼을 이용해 결정적 게이트웨이 ID를 생성한다.
// Windows 개발 PC에서는 모든 시리얼 읽기가 실패하므로 null → 무작위 ID.
import "server-only";
import { readFileSync } from "node:fs";
import { deriveGatewayId, shouldReprovision } from "./gateway-id";
import { loadStore, saveStore } from "./gateway-store";

/**
 * 하드웨어 시리얼 번호를 동기로 읽는다.
 * 1순위: 라즈베리파이 /sys/firmware/devicetree/base/serial-number
 * 2순위: /proc/cpuinfo 의 Serial 행
 * 3순위: /etc/machine-id
 * 모두 실패하면 null 반환 (Windows 개발 환경 등).
 */
export function readHardwareSerial(): string | null {
  // 1순위: 라즈베리파이 디바이스 트리 시리얼.
  try {
    const raw = readFileSync("/sys/firmware/devicetree/base/serial-number", "utf-8");
    // NUL 문자(\x00) 제거 및 공백 정리.
    const serial = raw.replace(/\x00/g, "").trim();
    if (serial) return serial;
  } catch {
    // 파일 없음 → 다음 시도.
  }

  // 2순위: /proc/cpuinfo 의 Serial 항목.
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf-8");
    const match = cpuinfo.match(/Serial\s*:\s*(\w+)/);
    if (match?.[1]) return match[1];
  } catch {
    // 파일 없음 → 다음 시도.
  }

  // 3순위: /etc/machine-id.
  try {
    const machineId = readFileSync("/etc/machine-id", "utf-8").trim();
    if (machineId) return machineId;
  } catch {
    // 파일 없음 → null 반환.
  }

  return null;
}

/**
 * 스토어에서 게이트웨이 ID를 가져오거나, 없으면 새로 생성해 저장한다.
 * - 스토어에 이미 있고 하드웨어가 동일하면 그대로 반환 (재부팅 후에도 동일).
 * - 스토어에 있지만 하드웨어 시리얼이 달라진 경우(SSD 복제 감지):
 *   현재 시리얼로 ID를 재생성하고 물려받은 토큰을 폐기한다.
 * - 스토어에 없으면 현재 시리얼로 결정적 ID를 도출하고 저장.
 */
export async function getOrCreateGatewayId(): Promise<string> {
  const store = await loadStore();
  // 현재 하드웨어 시리얼을 먼저 읽어 복제 여부 판단에 활용한다.
  const currentSerial = readHardwareSerial();

  if (store.gatewayId) {
    // 스토어에 ID가 존재하는 경우: 하드웨어가 바뀌었는지 확인.
    if (shouldReprovision(store.hardwareSerial, currentSerial)) {
      // SSD 복제로 판단: 현재 시리얼로 ID를 재생성하고 물려받은 토큰을 폐기한다.
      const id = deriveGatewayId(currentSerial);
      await saveStore({
        gatewayId: id,
        hardwareSerial: currentSerial,
        gatewayToken: null,
        registeredAt: null,
        registrationCode: null,
        codeExpiresAt: null,
      });
      console.log(
        `[gateway] SSD 복제 감지: 시리얼 ${store.hardwareSerial} → ${currentSerial}, 게이트웨이 ID 재생성 및 토큰 폐기.`,
      );
      return id;
    }
    // 하드웨어가 동일하면 기존 ID를 그대로 반환.
    return store.gatewayId;
  }

  // 스토어에 ID가 없는 경우: 현재 시리얼로 결정적 ID를 도출하고 저장.
  const id = deriveGatewayId(currentSerial);
  await saveStore({ gatewayId: id, hardwareSerial: currentSerial });
  return id;
}
