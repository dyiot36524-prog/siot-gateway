// matterjs-server WebSocket 클라이언트.
// 프로토콜: 요청 {message_id, command, args} / 응답 {message_id, result} 또는 {message_id, error_code, details}
//           이벤트 {event, data}  (node_added, node_updated, node_removed, attribute_updated, node_event, ...)
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { logger } from './log.js';

const log = logger('matter');

export class MatterClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.serverInfo = null;
    this.closed = false;
    this.reconnectDelay = 1000;
  }

  connect() {
    this.closed = false;
    return new Promise((resolve, reject) => {
      log.info(`connecting ${this.url}`);
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      ws.on('open', () => { this.reconnectDelay = 1000; });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.message_id !== undefined) {
          const p = this.pending.get(msg.message_id);
          if (!p) return;
          this.pending.delete(msg.message_id);
          if (msg.error_code !== undefined) p.reject(new MatterError(msg.error_code, msg.details));
          else p.resolve(msg.result);
          return;
        }
        if (msg.event) {
          if (msg.event === 'server_info' || msg.event === 'server_info_updated') this.serverInfo = msg.data;
          this.emit('event', msg.event, msg.data);
          this.emit(msg.event, msg.data);
          if (msg.event === 'server_info' && !settled) { settled = true; resolve(msg.data); }
          return;
        }
        // 첫 메시지가 server_info 객체 자체로 올 수도 있음 (이벤트 래퍼 없이)
        if (msg.fabric_id !== undefined && !settled) { this.serverInfo = msg; settled = true; resolve(msg); }
      });
      ws.on('error', (err) => { log.error('ws error', err.message); if (!settled) { settled = true; reject(err); } });
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        this.emit('disconnected');
        if (!this.closed) {
          log.warn(`disconnected, reconnecting in ${this.reconnectDelay}ms`);
          setTimeout(() => this.connect().then(() => this.emit('reconnected')).catch(() => {}), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        }
      });
      // server_info 가 안 오는 경우를 대비한 타임아웃
      setTimeout(() => { if (!settled && ws.readyState === WebSocket.OPEN) { settled = true; resolve(null); } }, 3000);
    });
  }

  close() { this.closed = true; this.ws?.close(); }

  request(command, args = undefined, timeoutMs = 60_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const message_id = String(++this.seq);
    const payload = { message_id, command };
    if (args !== undefined) payload.args = args;
    log.debug(`-> ${command}`, args);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(message_id); reject(new Error(`timeout: ${command}`)); }, timeoutMs);
      this.pending.set(message_id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  // ---- 자주 쓰는 명령 래퍼 ----
  startListening() { return this.request('start_listening'); }
  getNodes() { return this.request('get_nodes'); }
  getNode(nodeId) { return this.request('get_node', { node_id: nodeId }); }
  setThreadDataset(dataset) { return this.request('set_thread_dataset', { dataset }); }   // 서버가 데이터셋에서 네트워크 이름을 읽음
  setWifiCredentials(ssid, credentials) { return this.request('set_wifi_credentials', { ssid, credentials }); }
  commissionWithCode(code, opts = {}) {
    // Thread/BLE 커미셔닝은 수 분까지 걸릴 수 있음
    return this.request('commission_with_code', { code, network_only: false, ...opts }, 5 * 60_000);
  }
  openCommissioningWindow(nodeId, timeout = 300) { return this.request('open_commissioning_window', { node_id: nodeId, timeout }); }
  removeNode(nodeId) { return this.request('remove_node', { node_id: nodeId }); }
  interviewNode(nodeId) { return this.request('interview_node', { node_id: nodeId }); }
  readAttribute(nodeId, path) { return this.request('read_attribute', { node_id: nodeId, attribute_path: path }); }
  writeAttribute(nodeId, path, value) { return this.request('write_attribute', { node_id: nodeId, attribute_path: path, value }); }
  deviceCommand(nodeId, endpointId, clusterId, commandName, payload = {}) {
    return this.request('device_command', { node_id: nodeId, endpoint_id: endpointId, cluster_id: clusterId, command_name: commandName, payload });
  }
  getThreadBorderRouters() { return this.request('get_thread_border_routers'); }
  getAllCredentials() { return this.request('get_all_credentials'); }
  pingNode(nodeId) { return this.request('ping_node', { node_id: nodeId }); }
}

export class MatterError extends Error {
  constructor(code, details) { super(`matter error ${code}: ${details ?? ''}`); this.code = code; this.details = details; }
}
