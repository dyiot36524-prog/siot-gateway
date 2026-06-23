// 게이트웨이 시스템 상태를 집계한다. HA 접근 포함 — server-only 필수.
// 함대 관리: 플랫폼이 /siot-app/api/v1/system을 폴링(pull)하는 모델을 기본으로 한다.
// 게이트웨이가 능동적으로 보내는 heartbeat(push)는 플랫폼 확정 후 추가.
import "server-only";
import { getGatewayId } from "./platform-auth";
import { loadStore } from "./gateway-store";
import { ping } from "./ha-client";
import { getDevices } from "./devices-service";

/** 프로세스 시작 시각 — uptime 계산용. */
const STARTED_AT = new Date().toISOString();

/** 플랫폼이 폴링으로 수집하는 게이트웨이 시스템 상태. */
export interface SystemStatus {
  gatewayId: string;
  version: string;
  registered: boolean;
  engineOnline: boolean;
  deviceCount: number | null;
  startedAt: string;
}

/** 현재 게이트웨이 시스템 상태를 수집해 반환한다. */
export async function getSystemStatus(): Promise<SystemStatus> {
  // 게이트웨이 식별자.
  const gatewayId = await getGatewayId();

  // 등록 여부: 스토어에 gatewayToken이 있으면 등록 완료.
  const store = await loadStore();
  const registered = !!store.gatewayToken;

  // HA 엔진 온라인 여부: 실패하면 false 처리.
  let engineOnline = false;
  try {
    engineOnline = await ping();
  } catch {
    engineOnline = false;
  }

  // 기기 수: HA 다운 시 null 반환(알 수 없음과 0을 구분).
  let deviceCount: number | null = null;
  try {
    deviceCount = (await getDevices()).length;
  } catch {
    deviceCount = null;
  }

  // 배포 버전.
  const version = process.env.SIOT_GATEWAY_VERSION ?? "0.1.0";

  return {
    gatewayId,
    version,
    registered,
    engineOnline,
    deviceCount,
    startedAt: STARTED_AT,
  };
}
