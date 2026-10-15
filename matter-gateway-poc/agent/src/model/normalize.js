// matterjs-server 노드 스냅샷 → 중립 디바이스 모델
// 중립 모델은 소스(matter/zigbee/lifesmart)에 무관하게 capability 단위로 상태를 표현한다.
import { CL, ATTR, DEVICE_TYPE_NAME } from './clusters.js';

export const deviceIdFor = (nodeId) => `matter:${nodeId}`;

const num = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? null : Number(v));

/** 디바이스 타입 리스트 값은 구현에 따라 {deviceType, revision} 또는 {"0":..,"1":..} 형태일 수 있음 */
function deviceTypesFrom(list) {
  if (!Array.isArray(list)) return [];
  return list.map((e) => num(e?.deviceType ?? e?.['0'] ?? e)).filter((n) => n != null);
}

/** 단일 속성(경로) 값을 capability 변경으로 변환. 반환: {endpoint, capability, field, value} | null */
export function attributeToCapability(path, value) {
  const [epS, clS, atS] = path.split('/');
  const ep = Number(epS), cl = Number(clS), at = Number(atS);
  const r = (capability, field, v) => ({ endpoint: ep, capability, field, value: v });
  switch (cl) {
    case CL.ON_OFF:
      if (at === ATTR.ON_OFF_ON) return r('onoff', 'on', Boolean(value));
      return null;
    case CL.LEVEL:
      if (at === ATTR.LEVEL_CURRENT && value != null) return r('level', 'percent', Math.round((num(value) / 254) * 100));
      return null;
    case CL.BOOLEAN_STATE:
      // Matter BooleanState: true = closed(contact), false = open
      if (at === ATTR.BOOLEAN_STATE_VALUE) return r('contact', 'open', !value);
      return null;
    case CL.POWER_SOURCE:
      if (at === ATTR.POWER_BAT_PERCENT && value != null) return r('battery', 'percent', Math.round(num(value) / 2)); // 0.5% 단위
      if (at === ATTR.POWER_BAT_CHARGE_LEVEL && value != null) return r('battery', 'low', num(value) >= 1);
      return null;
    case CL.ELEC_POWER:
      if (at === ATTR.ELEC_POWER_ACTIVE_POWER && value != null) return r('power', 'watts', num(value) / 1000);   // mW
      if (at === ATTR.ELEC_POWER_VOLTAGE && value != null) return r('power', 'volts', num(value) / 1000);        // mV
      if (at === ATTR.ELEC_POWER_ACTIVE_CURRENT && value != null) return r('power', 'amps', num(value) / 1000);  // mA
      return null;
    case CL.ELEC_ENERGY:
      if (at === ATTR.ELEC_ENERGY_CUMULATIVE_IMPORTED && value != null) {
        const mwh = num(value?.energy ?? value?.['0'] ?? value);
        return mwh == null ? null : r('energy', 'kwh', mwh / 1_000_000);
      }
      return null;
    case CL.OCCUPANCY:
      if (at === ATTR.MEASURED_VALUE) return r('motion', 'detected', (num(value) & 1) === 1);
      return null;
    case CL.TEMPERATURE:
      if (at === ATTR.MEASURED_VALUE && value != null) return r('temperature', 'celsius', num(value) / 100);
      return null;
    case CL.HUMIDITY:
      if (at === ATTR.MEASURED_VALUE && value != null) return r('humidity', 'percent', num(value) / 100);
      return null;
    case CL.ILLUMINANCE:
      if (at === ATTR.MEASURED_VALUE && value != null) return r('illuminance', 'lux', Math.round(10 ** ((num(value) - 1) / 10000)));
      return null;
    default:
      return null;
  }
}

/** 노드 스냅샷 전체 → 중립 디바이스 */
export function normalizeNode(node) {
  const attrs = node.attributes ?? {};
  const get = (ep, cl, at) => attrs[`${ep}/${cl}/${at}`];
  const device = {
    id: deviceIdFor(node.node_id),
    source: 'matter',
    nodeId: node.node_id,
    online: Boolean(node.available),
    info: {
      vendorId: num(get(0, CL.BASIC_INFO, ATTR.BASIC_VENDOR_ID)),
      vendorName: get(0, CL.BASIC_INFO, ATTR.BASIC_VENDOR_NAME) ?? null,
      productId: num(get(0, CL.BASIC_INFO, ATTR.BASIC_PRODUCT_ID)),
      productName: get(0, CL.BASIC_INFO, ATTR.BASIC_PRODUCT_NAME) ?? null,
      label: get(0, CL.BASIC_INFO, ATTR.BASIC_NODE_LABEL) ?? null,
      serial: get(0, CL.BASIC_INFO, ATTR.BASIC_SERIAL) ?? null,
      swVersion: get(0, CL.BASIC_INFO, ATTR.BASIC_SW_VERSION_STR) ?? null,
      hwVersion: get(0, CL.BASIC_INFO, ATTR.BASIC_HW_VERSION_STR) ?? null,
    },
    commissionedAt: node.date_commissioned ?? null,
    endpoints: {},
  };
  for (const [path, value] of Object.entries(attrs)) {
    const [epS, clS, atS] = path.split('/');
    const ep = Number(epS);
    if (!device.endpoints[ep]) device.endpoints[ep] = { id: ep, deviceTypes: [], kinds: [], capabilities: {} };
    if (Number(clS) === CL.DESCRIPTOR && Number(atS) === ATTR.DESCRIPTOR_DEVICE_TYPE_LIST) {
      const types = deviceTypesFrom(value);
      device.endpoints[ep].deviceTypes = types;
      device.endpoints[ep].kinds = types.map((t) => DEVICE_TYPE_NAME[t] ?? `unknown_${t}`);
      continue;
    }
    const cap = attributeToCapability(path, value);
    if (cap) {
      const caps = device.endpoints[ep].capabilities;
      (caps[cap.capability] ??= {})[cap.field] = cap.value;
    }
  }
  // 상태가 전혀 없는 루트 엔드포인트(0)는 노출 목록에서 제외
  for (const [ep, e] of Object.entries(device.endpoints)) {
    if (Number(ep) === 0 && Object.keys(e.capabilities).length === 0) delete device.endpoints[ep];
  }
  return device;
}
