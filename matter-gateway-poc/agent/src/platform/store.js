// 게이트웨이 영속 스토어 — siot-app lib/gateway-store.ts 와 같은 스키마/파일(gateway.json), 원자적 저장.
// 토큰과 장치 개인키가 들어 있으므로 파일 권한은 0600 이다.
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
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
    await writeFile(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);   // umask 영향 제거
    await rename(tmp, this.path);
    return merged;
  }
}
