// MATTER_BACKEND=sim — 실기기 없이 에이전트·릴레이·클라우드를 돌리기 위한 가짜 Matter 백엔드.
// platform.test.js 의 FakeMatter 를 승격했다. matterjs-server(MatterClient)와 같은 메서드·이벤트를 낸다.
//   기본 노드: 1 = 플러그(GRILLPLATS, OnOff+전력), 2 = 도어 센서(MYGGBETT, BooleanState+배터리)
//   도어 토글: SIM_DOOR_TOGGLE_MS(>0) 주기로 자동, 또는 toggleDoor() (dev/로컬 API POST .../sim/door)
//   커미셔닝: 코드에 FAIL 이 들어가면 "no device found", THREAD 가 들어가면 Thread 미설정 오류. 그 외는 도어 센서 추가
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('sim');

export const SIM_PLUG = Object.freeze({ node_id: 1, available: true, attributes: { '0/40/1': 'IKEA of Sweden', '0/40/3': 'GRILLPLATS', '1/29/0': [{ deviceType: 266, revision: 3 }], '1/6/0': false, '1/144/8': 12500 } });
export const SIM_DOOR = Object.freeze({ node_id: 2, available: true, attributes: { '0/40/1': 'IKEA of Sweden', '0/40/3': 'MYGGBETT', '1/29/0': [{ deviceType: 21, revision: 1 }], '1/69/0': true, '1/47/12': 180 } });

const clone = (n) => JSON.parse(JSON.stringify(n));

export class MatterSim extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {object[]} [o.nodes]        초기 노드(기본 플러그+도어)
   * @param {number} [o.doorToggleMs]   >0 이면 그 주기로 도어 상태를 뒤집는다
   * @param {number} [o.doorNodeId]     토글 대상 노드(기본 2)
   */
  constructor(o = {}) {
    super();
    this.isSim = true;
    this.nodes = new Map((o.nodes ?? [SIM_PLUG, SIM_DOOR]).map((n) => [n.node_id, clone(n)]));
    this.nextNodeId = Math.max(0, ...this.nodes.keys()) + 1;
    this.serverInfo = { backend: 'sim', fabric_id: 1, sdk_version: 'sim', thread_credentials_set: true, bluetooth_enabled: true };
    this.commands = [];
    this.doorToggleMs = Number(o.doorToggleMs ?? 0);
    this.doorNodeId = o.doorNodeId ?? 2;
    this.timer = null;
  }

  async connect() { return this.serverInfo; }
  async startListening() {
    if (this.doorToggleMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.toggleDoor(), this.doorToggleMs);
      this.timer.unref?.();
      log.info(`door toggle every ${this.doorToggleMs}ms (node ${this.doorNodeId})`);
    }
    return [...this.nodes.values()].map(clone);
  }
  close() { clearInterval(this.timer); this.timer = null; }

  #setAttr(nodeId, path, value) {
    const n = this.nodes.get(nodeId);
    if (n) n.attributes[path] = value;
    this.emit('attribute_updated', [nodeId, path, value]);
  }

  /** BooleanState(69) StateValue 를 뒤집는다. true=닫힘(접점 붙음), false=열림 */
  toggleDoor(nodeId = this.doorNodeId) {
    const n = this.nodes.get(nodeId);
    if (!n) throw new Error(`unknown sim node ${nodeId}`);
    const next = !n.attributes['1/69/0'];
    this.#setAttr(nodeId, '1/69/0', next);
    return { nodeId, closed: next };
  }

  async deviceCommand(nodeId, ep, cl, name, payload) {
    this.commands.push({ nodeId, ep, cl, name, payload });
    if (cl === 6) {
      const cur = Boolean(this.nodes.get(nodeId)?.attributes[`${ep}/6/0`]);
      this.#setAttr(nodeId, `${ep}/6/0`, name === 'On' ? true : name === 'Off' ? false : !cur);
    }
    return null;
  }

  async commissionWithCode(code) {
    if (/FAIL/i.test(code)) throw new Error('no device found (sim)');
    if (/THREAD/i.test(code)) throw new Error('thread dataset not set (sim)');
    const node = { ...clone(SIM_DOOR), node_id: this.nextNodeId++ };
    this.nodes.set(node.node_id, node);
    return clone(node);
  }
  async setThreadDataset() { this.serverInfo.thread_credentials_set = true; return true; }
  async openCommissioningWindow(nodeId, timeout) { return { setup_manual_code: '34970112332', setup_qr_code: 'MT:TEST', timeout }; }
  async removeNode(nodeId) { this.nodes.delete(nodeId); return true; }
}
