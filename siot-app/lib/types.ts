// 시옷앱 공용 타입.
// 단계 1은 HA 원본(raw) 타입만 정의한다. 시옷 표준 DeviceType/data 변환은 단계 2(device-mapper).

/** HA `/api/states` 응답의 단일 엔티티 (원본 형태). */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

// ── 시옷 표준 기기 모델 (단계 2) ───────────────────────────────
// HA의 entity를 시옷앱/시옷플랫폼이 쓰는 표준 형태로 정규화한 결과.
// ※ 정식 필드명은 추후 `시옷앱_연동_API명세서`로 확정. 지금은 합리적 기본값.

/** 시옷 표준 기기 종류. HA domain + device_class로 결정한다. */
export const DEVICE_TYPES = [
  "PLUG",
  "SWITCH",
  "LIGHT",
  "SENSOR",
  "BINARY_SENSOR",
  "COVER",
  "CLIMATE",
  "FAN",
  "LOCK",
  "WEATHER",
  "UNKNOWN",
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** 정규화된 data 값으로 허용하는 타입. */
export type SiotDataValue = string | number | boolean | null;

/** 시옷 표준 기기. HA entity 1개 = SiotDevice 1개. */
export interface SiotDevice {
  /** HA entity_id (예: "switch.living_plug"). 시옷앱 내부 식별자로 사용. */
  id: string;
  /** 표시 이름 (HA friendly_name, 없으면 entity_id). */
  name: string;
  /** 시옷 표준 기기 종류. */
  deviceType: DeviceType;
  /** 통신 가능 여부 (state가 unavailable/unknown이면 false). */
  online: boolean;
  /** 정규화된 능력값 맵 (예: {switch:true, power:12.3}). */
  data: Record<string, SiotDataValue>;
  /** HA 기준 마지막 갱신 시각(ISO). */
  lastUpdated: string;
}

/** ha-client 호출 실패를 표현하는 에러. status가 있으면 HA가 응답한 HTTP 코드. */
export class HaClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HaClientError";
  }
}
