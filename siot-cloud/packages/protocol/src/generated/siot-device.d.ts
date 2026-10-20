/* 자동 생성 파일 — 직접 고치지 말 것. 원본: packages/protocol/schema/siot-device.json, 생성: npm run gen */

/**
 * This interface was referenced by `SiotDevice`'s JSON-Schema
 * via the `definition` "DeviceType".
 */
export type DeviceType =
  | 'PLUG'
  | 'SWITCH'
  | 'LIGHT'
  | 'SENSOR'
  | 'BINARY_SENSOR'
  | 'COVER'
  | 'CLIMATE'
  | 'FAN'
  | 'LOCK'
  | 'WEATHER'
  | 'UNKNOWN';

/**
 * 게이트웨이 로컬 표준 기기(엔드포인트 1개 = 1개). matter-gateway-poc/docs/openapi.yaml 의 SiotDevice 를 이관했고 agent/src/platform/siotMapper.js toSiotDevices() 출력과 같다. 클라우드 공개 API 의 Device 는 이 값을 deviceId(dev_+ULID) 로 감싼다(localId = id).
 */
export interface SiotDevice {
  /**
   * <source>:<nodeId>:<endpoint> (게이트웨이 내부 localId)
   */
  id: string;
  name: string;
  deviceType: DeviceType;
  online: boolean;
  data: DeviceData;
  lastUpdated: string;
  /**
   * 추가 필드(무시 가능)
   */
  source?: string;
  vendor?: string | null;
  model?: string | null;
}
/**
 * deviceType 별 정규화 값.
 * PLUG/SWITCH/FAN: switch(bool), power(W)?, energy(kWh)?, battery?
 * LIGHT: switch, brightness(0-100)?
 * BINARY_SENSOR: active(bool; 문열림=true), measurement("door"|"motion"), battery(%)?, batteryLow?
 * SENSOR: value, unit, measurement, energy?, battery?
 * UNKNOWN: state="unknown"
 *
 * This interface was referenced by `SiotDevice`'s JSON-Schema
 * via the `definition` "DeviceData".
 */
export interface DeviceData {
  [k: string]: (string | number | boolean | null) | undefined;
}
