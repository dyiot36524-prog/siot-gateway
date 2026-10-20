// 세대 설정(cfg 프레임) 저장소. M1 범위는 "저장 + cfg_ack" 뿐이다.
// 키 목록 검증·피어·규칙 적용·thread 모드는 Step 5/3b 에서 확장한다(docs/relay-protocol.md).
// 파일: <dataDir>/site.json (세대 키 포함 → 0600, 원자적 저장)
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { logger } from '../log.js';

const log = logger('site');

export class SiteConfig {
  constructor(dataDir) { this.dataDir = dataDir; this.path = path.join(dataDir, 'site.json'); this.cfg = null; }

  async load() {
    try { this.cfg = JSON.parse(await readFile(this.path, 'utf8')); } catch { this.cfg = null; }
    return this.cfg;
  }

  get cfgVersion() { return intOr0(this.cfg?.cfgVersion); }
  /** 허용 키 목록 중 가장 높은 버전(키가 없으면 0) */
  get keyVersion() { return Math.max(0, ...(this.cfg?.keys ?? []).map((k) => intOr0(k?.v))); }
  get rulesVersion() { return intOr0(this.cfg?.rules?.version); }

  /** cfg_ack 본문(t 제외) */
  ack() { return { cfgVersion: this.cfgVersion, keyVersion: this.keyVersion, rulesVersion: this.rulesVersion }; }

  /**
   * cfg 를 멱등 적용한다. 같은 버전 재전송은 그대로 ack, 더 낮은 버전은 무시하고 현재 버전으로 ack 한다.
   * @returns {Promise<{cfgVersion:number, keyVersion:number, rulesVersion:number}>}
   */
  async apply(cfg) {
    const v = Number(cfg?.cfgVersion);
    if (!Number.isInteger(v) || v < 0) throw new Error(`invalid cfgVersion: ${cfg?.cfgVersion}`);
    if (this.cfg && v < this.cfgVersion) { log.warn(`옛 cfg 무시: ${v} < ${this.cfgVersion}`); return this.ack(); }
    const { t: _t, ...body } = cfg;
    await mkdir(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, `.site.tmp.${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, JSON.stringify({ ...body, appliedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    this.cfg = body;
    log.info(`cfg 적용 v${v} (keyVersion=${this.keyVersion}, rulesVersion=${this.rulesVersion})`);
    return this.ack();
  }
}

function intOr0(x) { const n = Number(x); return Number.isInteger(n) && n >= 0 ? n : 0; }
