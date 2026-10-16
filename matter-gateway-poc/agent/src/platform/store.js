// 게이트웨이 영속 스토어 — siot-app lib/gateway-store.ts 와 같은 스키마/파일(gateway.json), 원자적 저장.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export class GatewayStore {
  constructor(dataDir) { this.dataDir = dataDir; this.path = path.join(dataDir, 'gateway.json'); }
  async load() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); } catch { return {}; }
  }
  async save(patch) {
    await mkdir(this.dataDir, { recursive: true });
    const merged = { ...(await this.load()), ...patch };
    const tmp = path.join(this.dataDir, `.gateway.tmp.${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
    await rename(tmp, this.path);
    return merged;
  }
}
