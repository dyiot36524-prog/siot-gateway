// 게이트웨이 에이전트 진입점.
//  Matter 백엔드(matterjs-server | 임베드) ↔ 중립 디바이스 레지스트리 ↔ 플랫폼 API(siot-app 계약) / 로컬 페이지 / 룰 엔진
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './log.js';
import { createMatterBackend } from './matterBackend.js';
import { DeviceRegistry } from './model/registry.js';
import { executeCommand } from './commands.js';
import { PairingManager } from './pairing.js';
import { RulesEngine } from './rules.js';
import { GatewayStore } from './platform/store.js';
import { Identity } from './platform/identity.js';
import { PlatformServer } from './platform/server.js';
import { startMdns } from './platform/mdns.js';
import { RelayAgent } from './platform/relay.js';
import { startDatasetSync } from './platform/otbr.js';

const log = logger('agent');

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  const store = new GatewayStore(config.siotDataDir);
  const identity = new Identity(store);
  const gatewayId = await identity.gatewayId();
  log.info(`gatewayId=${gatewayId} (short ${gatewayId.slice(3, 11)})`);

  const registry = new DeviceRegistry();
  const matter = await createMatterBackend();
  const pairing = new PairingManager(matter, registry);
  const execute = (cmd) => executeCommand(matter, registry, cmd);
  const rules = new RulesEngine(registry, execute, { file: config.rulesFile, publish: () => {} });
  await rules.load();

  // ---- 플랫폼/로컬 API (먼저 띄워 Matter 서버가 늦어도 로컬 페이지와 claim 은 동작) ----
  const api = new PlatformServer({ store, identity, registry, execute, pairing, matter, opts: { port: config.port, version: config.version } });
  await api.listen();
  const stopMdns = await startMdns(identity, config.port);
  const relay = new RelayAgent({ relayUrl: config.relayUrl, identity, store, port: config.port });
  api.onClaimed = (token) => relay.restartWithToken(token).catch((e) => log.warn(e.message));
  await relay.start();

  // ---- Matter 백엔드 ----
  matter.on('node_added', (n) => registry.upsertNode(n));
  matter.on('node_updated', (n) => registry.upsertNode(n));
  matter.on('node_removed', (id) => registry.removeNode(id));
  matter.on('attribute_updated', ([nodeId, p, v]) => registry.applyAttribute(nodeId, p, v));
  matter.on('node_event', (ev) => log.debug('node_event', ev));
  const sync = async () => {
    const nodes = await matter.startListening();
    for (const n of nodes ?? []) registry.upsertNode(n);
    log.info(`synced ${nodes?.length ?? 0} nodes; thread_credentials_set=${matter.serverInfo?.thread_credentials_set} ble=${matter.serverInfo?.bluetooth_enabled}`);
  };
  const connectMatter = async () => {
    for (let attempt = 1; ; attempt++) {
      try { await matter.connect(); await sync(); return; }
      catch (e) { const d = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)); log.warn(`matter backend not ready (${e.message}); retry in ${d}ms`); await new Promise((r) => setTimeout(r, d)); }
    }
  };
  await connectMatter();
  matter.on('reconnected', () => sync().catch((e) => log.error('resync failed', e.message)));

  // ---- OTBR 데이터셋 자동 등록 ----
  const stopSync = config.otbrRestUrl ? startDatasetSync({ restUrl: config.otbrRestUrl, matter, pairing }) : () => {};

  const shutdown = async () => { log.info('shutting down'); stopSync(); stopMdns(); relay.stop(); await api.close(); matter.close?.(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.error('fatal', e.stack ?? e.message); process.exit(1); });
