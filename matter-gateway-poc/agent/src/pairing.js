// 페어링 세션: 앱이 보낸 Matter 셋업 코드(QR "MT:..." 또는 11/21자리 수동 코드)로 게이트웨이가 직접 커미셔닝.
// 진행 단계는 'progress' 이벤트로 흘려 앱에 전달한다.
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('pairing');

export class PairingManager extends EventEmitter {
  constructor(matter, registry) { super(); this.matter = matter; this.registry = registry; this.active = null; }

  /** Thread 데이터셋(ot-ctl dataset active -x 결과 hex)을 컨트롤러에 등록. 한 번만 하면 저장됨 */
  async setThreadDataset(datasetHex, networkName) {
    const res = await this.matter.setThreadDataset(datasetHex.trim(), networkName);
    log.info('thread dataset set', res);
    return res;
  }

  async ensureThreadCredentials() {
    const info = this.matter.serverInfo;
    if (info && info.thread_credentials_set === false) throw new Error('thread dataset not set (run: cli dataset <hex>)');
  }

  /** @returns {Promise<device>} */
  async start({ sessionId, code, threadDataset, threadNetworkName }) {
    if (this.active) throw new Error(`pairing already running: ${this.active}`);
    this.active = sessionId;
    const progress = (stage, extra = {}) => { log.info(`[${sessionId}] ${stage}`, extra); this.emit('progress', { sessionId, stage, at: Date.now(), ...extra }); };
    try {
      if (threadDataset) { progress('thread_dataset'); await this.setThreadDataset(threadDataset, threadNetworkName); }
      await this.ensureThreadCredentials();
      progress('commissioning', { hint: '게이트웨이가 BLE 로 장치를 찾고(PASE) 인증 후 Thread 네트워크에 가입시킵니다' });
      const node = await this.matter.commissionWithCode(code);
      progress('interviewing', { nodeId: node?.node_id });
      const device = this.registry.upsertNode(node);
      progress('done', { deviceId: device.id, device });
      return device;
    } catch (err) {
      progress('failed', { error: err.message });
      throw err;
    } finally {
      this.active = null;
    }
  }

  /** 멀티 어드민: 다른 생태계(Apple Home 등)가 추가로 등록할 수 있게 창을 연다. 결과에 수동코드/QR 포함 */
  async openWindow(deviceId, timeoutSec = 300) {
    const d = this.registry.get(deviceId);
    if (!d) throw new Error(`unknown device ${deviceId}`);
    return this.matter.openCommissioningWindow(d.nodeId, timeoutSec);
  }

  async remove(deviceId) {
    const d = this.registry.get(deviceId);
    if (!d) throw new Error(`unknown device ${deviceId}`);
    await this.matter.removeNode(d.nodeId);
    this.registry.removeNode(d.nodeId);
  }
}
