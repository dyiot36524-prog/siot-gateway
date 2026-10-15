// 중립 디바이스 레지스트리. 이벤트:
//   'device.added' (device) / 'device.updated' (device) / 'device.removed' (deviceId)
//   'state' ({deviceId, endpoint, capability, field, value, prev})
import { EventEmitter } from 'node:events';
import { normalizeNode, attributeToCapability, deviceIdFor } from './normalize.js';

export class DeviceRegistry extends EventEmitter {
  constructor() { super(); this.devices = new Map(); }

  list() { return [...this.devices.values()]; }
  get(deviceId) { return this.devices.get(deviceId); }
  getByNode(nodeId) { return this.devices.get(deviceIdFor(nodeId)); }

  upsertNode(node) {
    const device = normalizeNode(node);
    const existed = this.devices.has(device.id);
    this.devices.set(device.id, device);
    this.emit(existed ? 'device.updated' : 'device.added', device);
    return device;
  }

  removeNode(nodeId) {
    const id = deviceIdFor(nodeId);
    if (this.devices.delete(id)) this.emit('device.removed', id);
  }

  setOnline(nodeId, online) {
    const d = this.getByNode(nodeId);
    if (d && d.online !== online) { d.online = online; this.emit('device.updated', d); }
  }

  /** attribute_updated 이벤트 data: [nodeId, "ep/cluster/attr", value] */
  applyAttribute(nodeId, path, value) {
    const d = this.getByNode(nodeId);
    if (!d) return null;
    const cap = attributeToCapability(path, value);
    if (!cap) return null;
    const ep = (d.endpoints[cap.endpoint] ??= { id: cap.endpoint, deviceTypes: [], kinds: [], capabilities: {} });
    const bucket = (ep.capabilities[cap.capability] ??= {});
    const prev = bucket[cap.field];
    bucket[cap.field] = cap.value;
    const change = { deviceId: d.id, endpoint: cap.endpoint, capability: cap.capability, field: cap.field, value: cap.value, prev, at: Date.now() };
    this.emit('state', change);
    return change;
  }
}
