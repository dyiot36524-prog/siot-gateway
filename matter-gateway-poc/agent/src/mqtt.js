// 플랫폼(클라우드) 연결. PoC 는 로컬 mosquitto, 실제는 플랫폼 브로커 + 게이트웨이별 mTLS 인증서.
// 토픽 (gw/<gatewayId>/...):
//   status                       (retained) {online, at}
//   device/<deviceId>            (retained) 중립 디바이스 전체
//   device/<deviceId>/state      capability 변경 {endpoint, capability, field, value, prev}
//   device/<deviceId>/removed
//   cmd              <- {reqId, deviceId, endpoint?, capability, action, params?}
//   cmd/result       -> {reqId, ok, error?}
//   pairing/start    <- {sessionId, code, threadDataset?}
//   pairing/event    -> {sessionId, stage, ...}
//   pairing/open-window <- {reqId, deviceId, timeout?}
//   pairing/remove   <- {reqId, deviceId}
//   rules/set        <- {rules:[...]}
import mqtt from 'mqtt';
import { logger } from './log.js';

const log = logger('mqtt');

export class CloudLink {
  constructor({ url, username, password, gatewayId }) {
    this.gatewayId = gatewayId;
    this.base = `gw/${gatewayId}`;
    this.client = mqtt.connect(url, {
      username, password, clientId: `agent-${gatewayId}`, reconnectPeriod: 2000,
      will: { topic: `${this.base}/status`, payload: JSON.stringify({ online: false }), retain: true, qos: 1 },
    });
    this.handlers = new Map();
    this.client.on('connect', () => {
      log.info('connected');
      this.publish('status', { online: true, at: Date.now() }, { retain: true });
      for (const t of this.handlers.keys()) this.client.subscribe(`${this.base}/${t}`);
    });
    this.client.on('error', (e) => log.error(e.message));
    this.client.on('message', (topic, payload) => {
      const sub = topic.slice(this.base.length + 1);
      const h = this.handlers.get(sub);
      if (!h) return;
      let data = {};
      try { data = JSON.parse(payload.toString() || '{}'); } catch { log.warn(`bad json on ${topic}`); return; }
      Promise.resolve(h(data)).catch((e) => log.error(`${sub} handler failed`, e.message));
    });
  }
  publish(sub, data, opts = {}) {
    this.client.publish(`${this.base}/${sub}`, JSON.stringify(data), { qos: 1, ...opts });
  }
  on(sub, handler) {
    this.handlers.set(sub, handler);
    if (this.client.connected) this.client.subscribe(`${this.base}/${sub}`);
  }
  end() { return new Promise((r) => this.client.end(false, {}, r)); }
}
