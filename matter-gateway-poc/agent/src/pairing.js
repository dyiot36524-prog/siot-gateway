// 페어링 세션: 앱이 보낸 Matter 셋업 코드(QR "MT:..." 또는 11/21자리 수동 코드)로 게이트웨이가 직접 커미셔닝.
// 진행 단계는 'progress' 이벤트로 흘려 앱에 전달한다.
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('pairing');

// BLE 링크 계층에서 간헐적으로 나는 실패. Pi 5 내장 BT(BCM4345C0) ↔ IKEA(EFR32, Thread/BLE 동시 운용) 조합에서
// LE Create Connection 직후 "Connection Failed to be Established(0x3e)" 로 끊기는 일이 절반 가까이 관측됐다.
// matter.js 0.17.9 의 NobleBleChannel 은 'disconnect' 이벤트에만 재시도하고 connect 오류에는 재시도하지 않으므로
// 여기서 커미셔닝 전체를 다시 시도한다. (실패 1회당 matterjs-server 의 탐색 타임아웃 ≈ 3분)
const TRANSIENT_PATTERNS = [
  /Error while connecting to peripheral/i,
  /Failed to connect to peripheral/i,
  /unexpected state "error"/i,          // 패치 전 matter.js: 실패한 peripheral 이 error 상태로 남음
  /le-connection-abort-by-local/i,
  /Connection Failed to be Established/i,
  /Timeout while (connecting|interviewing|disconnecting)/i,
  /disconnected while trying to connect/i,
  /started attempt\(s\) failed, [1-9]\d* discovered/i,   // 장치는 찾았는데 시도가 실패 → 재시도 가치 있음
  /BLE transport closed|ble-channel-closed/i,            // 커미셔닝 도중 BLE 링크 끊김(supervision timeout 등)
  /Commission failed: Operation aborted/i,
];
// 재시도해도 소용없는 실패: 코드 오류, 장치 미발견, 인증 거부, 잘못된 패스코드
const PERMANENT_PATTERNS = [
  /No commissionable device was discovered/i,
  /invalid (arguments|pairing code|passcode|qr)/i,
  /Attestation rejected/i,
  /PASE.*(invalid|mismatch|wrong)/i,
  /thread dataset not set/i,
];

export function isTransientCommissionError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (PERMANENT_PATTERNS.some((re) => re.test(msg))) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

// 페어링 실패 분류(계획 E2). 앱/PWA 는 이 코드로 한국어 문구와 재시도 버튼을 고른다.
//   CODE_INVALID 코드 오류 · DEVICE_NOT_FOUND 기기 안 잡힘 · THREAD_NOT_READY Thread 미설정 · ATTESTATION_REJECTED 인증 거부
//   BLE_TRANSIENT BLE 일시 실패(시도 단위) · UNKNOWN 기타
// 최종 실패(세션 failed)에서는 재시도를 다 쓴 BLE_TRANSIENT 를 DEVICE_NOT_FOUND 로 보고한다(finalErrorCode).
export const PAIRING_ERROR_CODES = Object.freeze(['CODE_INVALID', 'DEVICE_NOT_FOUND', 'THREAD_NOT_READY', 'ATTESTATION_REJECTED', 'BLE_TRANSIENT', 'UNKNOWN']);
const CLASSIFIERS = [
  ['THREAD_NOT_READY', [/thread dataset not set/i, /thread credentials? (not set|missing)/i]],
  ['ATTESTATION_REJECTED', [/Attestation rejected/i, /attestation (failed|verification)/i]],
  ['CODE_INVALID', [/invalid (arguments|pairing code|passcode|qr|setup code|manual code)/i, /PASE.*(invalid|mismatch|wrong)/i, /(unable to|failed to|cannot) (parse|decode).*(code|qr|payload)/i]],
  ['DEVICE_NOT_FOUND', [/No commissionable device was discovered/i, /no device found/i, /started attempt\(s\) failed, 0 discovered/i]],
  ['BLE_TRANSIENT', TRANSIENT_PATTERNS],
];

/** @returns {'CODE_INVALID'|'DEVICE_NOT_FOUND'|'THREAD_NOT_READY'|'ATTESTATION_REJECTED'|'BLE_TRANSIENT'|'UNKNOWN'} */
export function classifyCommissionError(err) {
  const msg = String(err?.message ?? err ?? '');
  for (const [code, patterns] of CLASSIFIERS) if (patterns.some((re) => re.test(msg))) return code;
  return 'UNKNOWN';
}

/** 세션 최종 실패 코드: BLE 재시도 소진은 "기기 안 잡힘" */
export function finalErrorCode(err) {
  const c = classifyCommissionError(err);
  return c === 'BLE_TRANSIENT' ? 'DEVICE_NOT_FOUND' : c;
}

export class PairingManager extends EventEmitter {
  /**
   * @param {object} matter   Matter 백엔드 (commissionWithCode 등)
   * @param {import('./model/registry.js').DeviceRegistry} registry
   * @param {object} [opts]
   * @param {number} [opts.maxAttempts]   커미셔닝 시도 횟수 (기본 3, env PAIRING_MAX_ATTEMPTS)
   * @param {number} [opts.retryDelayMs]  재시도 전 대기 (기본 3000)
   */
  constructor(matter, registry, opts = {}) {
    super();
    this.matter = matter; this.registry = registry; this.active = null;
    this.maxAttempts = Math.max(1, Number(opts.maxAttempts ?? process.env.PAIRING_MAX_ATTEMPTS ?? 3));
    this.retryDelayMs = Number(opts.retryDelayMs ?? 3000);
  }

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

  /** 커미셔닝을 최대 maxAttempts 회 시도. 일시적(BLE 링크) 실패만 재시도하고 진행 이벤트에 attempt 를 싣는다 */
  async commissionWithRetry(code, progress) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      progress('commissioning', {
        attempt, maxAttempts: this.maxAttempts,
        hint: attempt === 1
          ? '게이트웨이가 BLE 로 장치를 찾고(PASE) 인증 후 Thread 네트워크에 가입시킵니다'
          : `BLE 연결이 끊겨 다시 시도합니다 (${attempt}/${this.maxAttempts})`,
        ...(lastError ? { lastError: lastError.message, lastErrorCode: classifyCommissionError(lastError) } : {}),
      });
      try {
        return await this.matter.commissionWithCode(code);
      } catch (err) {
        lastError = err;
        if (attempt >= this.maxAttempts || !isTransientCommissionError(err)) throw err;
        log.warn(`commissioning attempt ${attempt}/${this.maxAttempts} failed (transient): ${err.message}`);
        if (this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    throw lastError;
  }

  /** @returns {Promise<device>} */
  async start({ sessionId, code, threadDataset, threadNetworkName }) {
    if (this.active) throw new Error(`pairing already running: ${this.active}`);
    this.active = sessionId;
    const progress = (stage, extra = {}) => { log.info(`[${sessionId}] ${stage}`, extra); this.emit('progress', { sessionId, stage, at: Date.now(), ...extra }); };
    try {
      if (threadDataset) { progress('thread_dataset'); await this.setThreadDataset(threadDataset, threadNetworkName); }
      await this.ensureThreadCredentials();
      const node = await this.commissionWithRetry(code, progress);
      progress('interviewing', { nodeId: node?.node_id });
      const device = this.registry.upsertNode(node);
      progress('done', { deviceId: device.id, device });
      return device;
    } catch (err) {
      progress('failed', { error: err.message, errorCode: finalErrorCode(err) });
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
