// HA entity → 시옷 표준 SiotDevice 변환. (단계 2)
// 순수 함수만 둔다 (HA 호출/네트워크 없음) → 단위 테스트로 검증 가능.
// HaState는 타입으로만 쓰므로 type import (런타임 의존 없음).
import type { DeviceType, HaState, SiotDataValue, SiotDevice } from "./types";

/** state가 통신 불가/미상 값인지. */
function isOffline(state: string): boolean {
  return state === "unavailable" || state === "unknown" || state === "";
}

/** "21.5" → 21.5, "on"/"off"/빈값 등 숫자가 아니면 null. */
function toNumber(state: string): number | null {
  if (state === "" || state === "on" || state === "off") return null;
  const n = Number(state);
  return Number.isFinite(n) ? n : null;
}

function attrNumber(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function attrString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === "string" ? v : null;
}

/** entity_id의 domain + device_class로 시옷 deviceType 결정. */
export function resolveDeviceType(
  domain: string,
  deviceClass: string | null,
): DeviceType {
  switch (domain) {
    case "switch":
      return deviceClass === "outlet" ? "PLUG" : "SWITCH";
    // input_boolean = 사용자 토글 헬퍼. 제어 가능한 스위치로 취급(테스트/가상 기기).
    case "input_boolean":
      return "SWITCH";
    case "light":
      return "LIGHT";
    case "sensor":
      return "SENSOR";
    case "binary_sensor":
      return "BINARY_SENSOR";
    case "cover":
      return "COVER";
    case "climate":
      return "CLIMATE";
    case "fan":
      return "FAN";
    case "lock":
      return "LOCK";
    case "weather":
      return "WEATHER";
    default:
      return "UNKNOWN";
  }
}

/** deviceType + state/attributes를 표준 data 맵으로 변환. */
function buildData(
  deviceType: DeviceType,
  state: string,
  attrs: Record<string, unknown>,
): Record<string, SiotDataValue> {
  const on = state === "on";
  switch (deviceType) {
    case "PLUG":
    case "SWITCH":
    case "FAN": {
      const data: Record<string, SiotDataValue> = { switch: on };
      // 전력 측정 지원 플러그면 power 노출.
      const power =
        attrNumber(attrs, "current_power_w") ?? attrNumber(attrs, "power");
      if (power !== null) data.power = power;
      return data;
    }
    case "LIGHT": {
      const data: Record<string, SiotDataValue> = { switch: on };
      const brightness = attrNumber(attrs, "brightness"); // HA: 0~255
      if (brightness !== null) {
        data.brightness = Math.round((brightness / 255) * 100); // 0~100 정규화
      }
      return data;
    }
    case "COVER": {
      const data: Record<string, SiotDataValue> = { open: state === "open" };
      const position = attrNumber(attrs, "current_position");
      if (position !== null) data.position = position;
      return data;
    }
    case "LOCK":
      return { locked: state === "locked" };
    case "CLIMATE": {
      const data: Record<string, SiotDataValue> = { mode: state };
      const current = attrNumber(attrs, "current_temperature");
      const target = attrNumber(attrs, "temperature");
      if (current !== null) data.temperature = current;
      if (target !== null) data.target = target;
      return data;
    }
    case "BINARY_SENSOR": {
      const data: Record<string, SiotDataValue> = { active: on };
      const measurement = attrString(attrs, "device_class");
      if (measurement) data.measurement = measurement;
      return data;
    }
    case "SENSOR": {
      const data: Record<string, SiotDataValue> = {};
      const num = toNumber(state);
      data.value = num !== null ? num : state; // 숫자면 숫자, 아니면 원문
      const unit = attrString(attrs, "unit_of_measurement");
      if (unit) data.unit = unit;
      const measurement = attrString(attrs, "device_class");
      if (measurement) data.measurement = measurement;
      return data;
    }
    case "WEATHER": {
      const data: Record<string, SiotDataValue> = { condition: state };
      const temp = attrNumber(attrs, "temperature");
      const humidity = attrNumber(attrs, "humidity");
      if (temp !== null) data.temperature = temp;
      if (humidity !== null) data.humidity = humidity;
      return data;
    }
    default:
      return { state };
  }
}

/** HA entity 1개 → 시옷 표준 기기 1개. */
export function mapEntity(entity: HaState): SiotDevice {
  const domain = entity.entity_id.split(".")[0];
  const deviceClass = attrString(entity.attributes, "device_class");
  const deviceType = resolveDeviceType(domain, deviceClass);

  return {
    id: entity.entity_id,
    name: attrString(entity.attributes, "friendly_name") ?? entity.entity_id,
    deviceType,
    online: !isOffline(entity.state),
    data: buildData(deviceType, entity.state, entity.attributes),
    lastUpdated: entity.last_updated,
  };
}

/**
 * HA states 목록 → 시옷 표준 기기 목록.
 * HA 내부 시스템 entity(update/sun/person/zone/...)는 제어/표시 대상이
 * 아니므로 기본적으로 제외한다. includeAll=true면 전부 변환.
 */
const SYSTEM_DOMAINS = new Set([
  "update",
  "sun",
  "person",
  "zone",
  "conversation",
  "tts",
  "todo",
  "event",
  "stt",
  "tag",
  "script",
  "automation",
  "scene",
  "input_number",
  "input_select",
  "input_text",
  "input_datetime",
  "number",
  "select",
  "button",
]);

/** 사용자에게 보여줄 기기인지 (HA 시스템 entity 제외). */
export function isUserFacing(entityId: string): boolean {
  const domain = entityId.split(".")[0];
  return !SYSTEM_DOMAINS.has(domain);
}

export function mapStates(
  states: HaState[],
  options?: { includeAll?: boolean },
): SiotDevice[] {
  const includeAll = options?.includeAll ?? false;
  return states
    .filter((e) => includeAll || isUserFacing(e.entity_id))
    .map(mapEntity);
}
