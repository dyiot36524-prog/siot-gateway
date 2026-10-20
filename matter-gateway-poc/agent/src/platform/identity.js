// 게이트웨이 식별자 — siot-app lib/gateway-id.ts / lib/gateway-identity.ts 와 동일 규칙.
// gatewayId = "gw_" + uuidv5(hwSerial, SIOT_NAMESPACE). 시리얼이 없으면 uuidv4.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { logger } from '../log.js';

const log = logger('identity');
export const SIOT_NAMESPACE = '6f1d2c9e-7a3b-5c4d-8e2f-1a2b3c4d5e6f';

/** RFC 4122 v5 (SHA-1) — uuid 패키지의 v5 와 동일한 결과 */
export function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  h[6] = (h[6] & 0x0f) | 0x50;   // version 5
  h[8] = (h[8] & 0x3f) | 0x80;   // variant RFC4122
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function deriveGatewayId(serial) {
  return 'gw_' + (serial ? uuidv5(serial, SIOT_NAMESPACE) : randomUUID());
}

export function shouldReprovision(storedSerial, currentSerial) {
  if (!storedSerial || !currentSerial) return false;
  return storedSerial !== currentSerial;
}

/** 1) Pi 디바이스트리 시리얼 2) /proc/cpuinfo Serial 3) /etc/machine-id (컨테이너에선 호스트 파일 마운트 필요) */
export function readHardwareSerial(paths = {}) {
  const dt = paths.deviceTree ?? process.env.SIOT_SERIAL_FILE ?? '/sys/firmware/devicetree/base/serial-number';
  try { const s = readFileSync(dt, 'utf8').replace(/\x00/g, '').trim(); if (s) return s; } catch { /* next */ }
  try { const m = readFileSync(paths.cpuinfo ?? '/proc/cpuinfo', 'utf8').match(/Serial\s*:\s*(\w+)/); if (m?.[1]) return m[1]; } catch { /* next */ }
  try { const s = readFileSync(paths.machineId ?? process.env.SIOT_MACHINE_ID_FILE ?? '/etc/machine-id', 'utf8').trim(); if (s) return s; } catch { /* none */ }
  return null;
}

export class Identity {
  constructor(store) { this.store = store; this.cached = null; }
  async gatewayId() {
    if (process.env.SIOT_GATEWAY_ID) return process.env.SIOT_GATEWAY_ID;
    if (this.cached) return this.cached;
    const s = await this.store.load();
    const current = readHardwareSerial();
    if (s.gatewayId) {
      if (shouldReprovision(s.hardwareSerial, current)) {
        const id = deriveGatewayId(current);
        // 복제된 SSD 는 원본과 같은 장치 키를 갖고 있으므로 키도 폐기하고 새로 만든다(백엔드 재등록 필요)
        await this.store.save({ gatewayId: id, hardwareSerial: current, gatewayToken: null, siteId: null, registeredAt: null, registrationCode: null, codeExpiresAt: null, deviceKey: null });
        this.key = null;
        log.warn(`SSD 복제 감지: 시리얼 ${s.hardwareSerial} → ${current}, gatewayId·장치 키 재생성 및 토큰 폐기 (재등록 필요)`);
        this.cached = id; return id;
      }
      this.cached = s.gatewayId; return s.gatewayId;
    }
    const id = deriveGatewayId(current);
    await this.store.save({ gatewayId: id, hardwareSerial: current });
    this.cached = id; return id;
  }
  async shortId() { return (await this.gatewayId()).slice(3, 11); }

  /**
   * Ed25519 장치 키. gateway.json(0600) 의 deviceKey 에 PKCS8 DER(base64)로 보관하고, 없으면 만든다.
   * 공개키는 raw 32바이트 base64url(릴레이 hello.pubKey, 축소 /api/gateway.pubKey).
   * @returns {Promise<{publicKey:string, sign:(data:string|Buffer)=>string}>}
   */
  async deviceKey() {
    await this.gatewayId();   // 복제 감지가 먼저 돌아 옛 키를 폐기하도록
    if (this.key) return this.key;
    const s = await this.store.load();
    let priv;
    if (s.deviceKey?.pkcs8) {
      try { priv = createPrivateKey({ key: Buffer.from(s.deviceKey.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }); }
      catch (e) { log.warn(`장치 키 손상 — 새로 생성 (재등록 필요): ${e.message}`); }
    }
    if (!priv) {
      priv = generateKeyPairSync('ed25519').privateKey;
      const pkcs8 = priv.export({ format: 'der', type: 'pkcs8' }).toString('base64');
      await this.store.save({ deviceKey: { alg: 'Ed25519', pkcs8, publicKey: rawPublicKey(priv), createdAt: new Date().toISOString() } });
      log.info('Ed25519 장치 키 생성');
    }
    const publicKey = rawPublicKey(priv);
    this.key = { publicKey, sign: (data) => edSign(null, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'), priv).toString('base64url') };
    return this.key;
  }
}

/** Ed25519 공개키 raw 32바이트(base64url). SPKI DER 의 마지막 32바이트가 raw 키다 */
export function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64url');
}
