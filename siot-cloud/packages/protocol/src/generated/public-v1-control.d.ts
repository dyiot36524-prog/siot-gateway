/* 자동 생성 파일 — 직접 고치지 말 것. 원본: packages/protocol/schema/public-v1-control.json, 생성: npm run gen */

import type { DeviceData, DeviceType } from './siot-device.js';

/**
 * This interface was referenced by `ControlResult`'s JSON-Schema
 * via the `definition` "ControlStatus".
 */
export type ControlStatus = 'confirmed' | 'timeout' | 'offline' | 'failed' | 'not_found';
/**
 * 'dev_' + ULID. 내부에서 (gatewayId, localId) 로 매핑
 *
 * This interface was referenced by `ControlResult`'s JSON-Schema
 * via the `definition` "DeviceId".
 */
export type DeviceId = string;

/**
 * POST /v1/devices/{deviceId}/control 와 POST /app/v1/devices/{deviceId}/control 의 응답 본문(항상 HTTP 200). 계획 Step 1 N1: confirmed = 목표값 evt 확인(또는 req 송신 전 before 가 이미 목표값), timeout = deadline 3000ms 초과 또는 req 무응답, offline = 감지된 미연결, failed = 로컬 400/502·기기 offline(reason), not_found = 로컬 404.
 */
export interface ControlResult {
  status: ControlStatus;
  /**
   * 응답 시점의 캐시 기기 값(evt·snapshot 로만 갱신된 값). not_found 이면 null.
   */
  device: PublicDevice | null;
  /**
   * API 수신부터 응답 결정까지(ms)
   */
  latencyMs: number;
  /**
   * failed/timeout 일 때 기계 판독용 코드(DEVICE_UNREACHABLE, GATEWAY_TIMEOUT 등)
   */
  reason?: string;
}
/**
 * This interface was referenced by `ControlResult`'s JSON-Schema
 * via the `definition` "Device".
 */
export interface PublicDevice {
  deviceId: DeviceId;
  gatewayId: string;
  siteId: string;
  name: string;
  room: string | null;
  deviceType: DeviceType;
  /**
   * 기기 online 이면서 게이트웨이도 online
   */
  online: boolean;
  data: DeviceData;
  lastUpdated: string;
  vendor?: string | null;
  model?: string | null;
}
