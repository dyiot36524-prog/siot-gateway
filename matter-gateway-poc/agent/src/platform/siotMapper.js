// 중립 디바이스 모델 → 시옷 표준 SiotDevice (siot-app lib/types.ts, lib/device-mapper.ts 와 호환)
// 규칙: 엔드포인트 1개 = SiotDevice 1개. id = "<deviceId>:<endpoint>" (예: "matter:12:1")
export const DEVICE_TYPES = ['PLUG', 'SWITCH', 'LIGHT', 'SENSOR', 'BINARY_SENSOR', 'COVER', 'CLIMATE', 'FAN', 'LOCK', 'WEATHER', 'UNKNOWN'];

const KIND_TO_TYPE = {
  onoff_plug: 'PLUG', dimmable_plug: 'PLUG',
  onoff_light: 'LIGHT', dimmable_light: 'LIGHT',
  onoff_switch: 'SWITCH', generic_switch: 'SWITCH',
  contact_sensor: 'BINARY_SENSOR', occupancy_sensor: 'BINARY_SENSOR',
  temperature_sensor: 'SENSOR', humidity_sensor: 'SENSOR', light_sensor: 'SENSOR', electrical_sensor: 'SENSOR',
};

export function resolveDeviceType(endpoint) {
  for (const k of endpoint.kinds ?? []) if (KIND_TO_TYPE[k]) return KIND_TO_TYPE[k];
  const c = endpoint.capabilities ?? {};
  if (c.contact || c.motion) return 'BINARY_SENSOR';
  if (c.level) return 'LIGHT';
  if (c.onoff) return c.power || c.energy ? 'PLUG' : 'SWITCH';
  if (c.temperature || c.humidity || c.illuminance) return 'SENSOR';
  return 'UNKNOWN';
}

function buildData(type, c) {
  switch (type) {
    case 'PLUG': case 'SWITCH': case 'FAN': {
      const d = { switch: Boolean(c.onoff?.on) };
      if (typeof c.power?.watts === 'number') d.power = c.power.watts;
      if (typeof c.energy?.kwh === 'number') d.energy = c.energy.kwh;
      if (typeof c.battery?.percent === 'number') d.battery = c.battery.percent;
      return d;
    }
    case 'LIGHT': {
      const d = { switch: Boolean(c.onoff?.on) };
      if (typeof c.level?.percent === 'number') d.brightness = c.level.percent;
      return d;
    }
    case 'BINARY_SENSOR': {
      if (c.contact) {
        const d = { active: Boolean(c.contact.open), measurement: 'door' };
        if (typeof c.battery?.percent === 'number') d.battery = c.battery.percent;
        if (typeof c.battery?.low === 'boolean') d.batteryLow = c.battery.low;
        return d;
      }
      const d = { active: Boolean(c.motion?.detected), measurement: 'motion' };
      if (typeof c.battery?.percent === 'number') d.battery = c.battery.percent;
      return d;
    }
    case 'SENSOR': {
      if (c.temperature) return withBattery({ value: c.temperature.celsius, unit: '°C', measurement: 'temperature' }, c);
      if (c.humidity) return withBattery({ value: c.humidity.percent, unit: '%', measurement: 'humidity' }, c);
      if (c.illuminance) return withBattery({ value: c.illuminance.lux, unit: 'lx', measurement: 'illuminance' }, c);
      return withBattery({ value: null }, c);
    }
    default:
      return { state: 'unknown' };
  }
}
function withBattery(d, c) { if (typeof c.battery?.percent === 'number') d.battery = c.battery.percent; return d; }

export function siotId(deviceId, endpointId) { return `${deviceId}:${endpointId}`; }
export function parseSiotId(id) {
  const i = id.lastIndexOf(':');
  if (i < 0) return null;
  const ep = Number(id.slice(i + 1));
  return Number.isInteger(ep) ? { deviceId: id.slice(0, i), endpoint: ep } : null;
}

/** 중립 디바이스 → SiotDevice[] (엔드포인트별). 루트(0)는 제외 */
export function toSiotDevices(device, nowIso = new Date().toISOString()) {
  const out = [];
  const eps = Object.values(device.endpoints ?? {}).filter((e) => e.id !== 0 && Object.keys(e.capabilities ?? {}).length);
  for (const ep of eps) {
    const type = resolveDeviceType(ep);
    const base = device.info?.label || device.info?.productName || device.id;
    out.push({
      id: siotId(device.id, ep.id),
      name: eps.length > 1 ? `${base} ${ep.id}` : base,
      deviceType: type,
      online: Boolean(device.online),
      data: buildData(type, ep.capabilities ?? {}),
      lastUpdated: device.lastUpdated ?? nowIso,
      // 추가 정보(시옷앱에는 없던 필드. 플랫폼이 무시해도 무방)
      source: device.source,
      vendor: device.info?.vendorName ?? null,
      model: device.info?.productName ?? null,
    });
  }
  return out;
}

// 시옷 action 문자열 → 중립 명령 (siot-app lib/control-map.ts 와 동일 action 집합)
const ACTION_TO_CMD = {
  ON: 'on', TURN_ON: 'on', SWITCH_ON: 'on', SWITCH_1_ON: 'on', PLUG_ON: 'on', OPEN: 'on',
  OFF: 'off', TURN_OFF: 'off', SWITCH_OFF: 'off', SWITCH_1_OFF: 'off', PLUG_OFF: 'off', CLOSE: 'off',
  TOGGLE: 'toggle',
};
export const SUPPORTED_ACTIONS = Object.keys(ACTION_TO_CMD);
export function resolveAction(action) {
  const a = ACTION_TO_CMD[String(action).trim().toUpperCase()];
  return a ? { capability: 'onoff', action: a, service: `matter.onoff.${a}` } : null;
}
