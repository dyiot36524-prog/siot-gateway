// registry·pairing 이벤트 → relay evt(kind device / device_removed / pairing) 연결. data 형태는 relay-v2 스키마(EvtDevice 등)와 같다.
import { toSiotDevices, parseSiotId } from './siotMapper.js';

/**
 * @param {object} o
 * @param {import('../model/registry.js').DeviceRegistry} o.registry
 * @param {import('../pairing.js').PairingManager} o.pairing
 * @param {(kind:string, data:object)=>void} o.publish
 */
export function wireRelayEvents({ registry, pairing, publish }) {
  // device_removed 는 제거 전 SiotDevice id 가 필요해 마지막 id 목록을 기억한다
  const lastIds = new Map();
  const pushDevice = (d) => { const devices = toSiotDevices(d); lastIds.set(d.id, devices.map((x) => x.id)); if (devices.length) publish('device', { devices }); };
  registry.on('device.added', pushDevice);
  registry.on('device.updated', pushDevice);
  registry.on('state', (c) => {
    const d = registry.get(c.deviceId); if (!d) return;
    const devices = toSiotDevices(d)
      .filter((s) => (s.endpointIds ?? [parseSiotId(s.id).endpoint]).includes(c.endpoint))
      .map((s) => ({ ...s, lastUpdated: new Date(c.at).toISOString() }));
    if (devices.length) publish('device', { devices });
  });
  registry.on('device.removed', (deviceId) => {
    const ids = lastIds.get(deviceId) ?? [];
    lastIds.delete(deviceId);
    if (ids.length) publish('device_removed', { deviceId, ids });
  });
  pairing.on('progress', (p) => publish('pairing', {
    sessionId: p.sessionId, stage: p.stage,
    ...(p.errorCode ? { errorCode: p.errorCode } : {}), ...(p.error ? { error: p.error } : {}),
    ...(p.deviceId ? { deviceId: p.deviceId } : {}), ...(p.device ? { devices: toSiotDevices(p.device) } : {}),
  }));
}
