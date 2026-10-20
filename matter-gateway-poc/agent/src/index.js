// 게이트웨이 에이전트 진입점.
//  Matter 백엔드(matterjs-server | 임베드 | sim) ↔ 중립 디바이스 레지스트리 ↔ 로컬 API(LAN 3000 / loopback 3001) ↔ relay-v2 ↔ 룰 엔진
import { mkdir, copyFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger, onLog } from './log.js';
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
import { wireRelayEvents } from './platform/relayEvents.js';
import { SiteConfig } from './site/siteConfig.js';
import { startHealthWriter } from './health.js';

const log = logger('agent');
const BOOT_ID = randomUUID();
const STARTED_AT = new Date().toISOString();
const LOG_EVT_PER_MIN = 10;

/** 규칙 파일이 없으면 이미지에 든 예시를 최초 1회 복사(/app/data/rules.json 은 쓰기 가능 볼륨) */
async function ensureRulesFile() {
  try { await access(config.rulesFile); return; } catch { /* 없음 */ }
  try { await copyFile(config.rulesSeedFile, config.rulesFile); log.info(`rules seeded: ${config.rulesSeedFile} → ${config.rulesFile}`); }
  catch (e) { log.warn(`rules seed 실패(빈 규칙으로 시작): ${e.message}`); }
}

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  log.info(`mode=${config.mode} version=${config.version} bootId=${BOOT_ID}`);
  const store = new GatewayStore(config.siotDataDir);
  const identity = new Identity(store);
  const gatewayId = await identity.gatewayId();
  const key = await identity.deviceKey();
  log.info(`gatewayId=${gatewayId} (short ${gatewayId.slice(3, 11)}) pubKey=${key.publicKey}`);
  const site = new SiteConfig(config.siotDataDir);
  await site.load();

  const registry = new DeviceRegistry();
  const matter = await createMatterBackend();
  const pairing = new PairingManager(matter, registry);
  const execute = (cmd) => executeCommand(matter, registry, cmd);
  await ensureRulesFile();
  const rules = new RulesEngine(registry, execute, { file: config.rulesFile, publish: () => {} });
  await rules.load();

  // ---- 로컬 API (먼저 띄워 Matter 서버가 늦어도 healthz·상태 페이지는 동작) ----
  const api = new PlatformServer({ store, identity, registry, execute, pairing, matter, opts: { mode: config.mode, port: config.port, adminPort: config.localAdminPort, version: config.version } });
  await api.listen();
  const stopMdns = await startMdns(identity, config.port);

  // ---- relay-v2 ----
  const engineOnline = () => Boolean(matter.serverInfo);
  const relay = new RelayAgent({
    relayUrl: config.relayUrl, identity, store, siteConfig: site, bootId: BOOT_ID, startedAt: STARTED_AT, version: config.version,
    proxyPort: config.mode === 'dev' ? config.port : config.localAdminPort,
    matterServerVersion: () => matter.serverInfo?.sdk_version ?? matter.serverInfo?.version ?? null,
    getSnapshot: async () => {
      const devices = api.listSiotDevices();
      const s = await store.load();
      return { gateway: { gatewayId, agentVersion: config.version, engineOnline: engineOnline(), deviceCount: devices.length, bound: Boolean(s.gatewayToken), mode: config.mode, startedAt: STARTED_AT, matterServerVersion: matter.serverInfo?.sdk_version ?? null, threadCredentialsSet: Boolean(matter.serverInfo?.thread_credentials_set) }, devices };
    },
  });
  if (config.mode === 'dev') api.onClaimed = () => relay.reconnectNow();   // dev 로컬 claim → 토큰으로 재접속. 출고는 릴레이 bind 가 처리
  const publish = (kind, data) => { try { relay.publish(kind, data); } catch (e) { log.debug(`evt drop: ${e.message}`); } };

  wireRelayEvents({ registry, pairing, publish });
  // WARN/ERROR 로그 → evt log (분당 10줄). relay 자신의 로그는 루프 방지를 위해 제외
  let logWindow = 0, logCount = 0;
  onLog(({ level, scope, msg }) => {
    if (scope === 'relay') return;
    const minute = Math.floor(performance.now() / 60_000);
    if (minute !== logWindow) { logWindow = minute; logCount = 0; }
    if (++logCount <= LOG_EVT_PER_MIN) publish('log', { level, scope, msg: msg.slice(0, 500) });
  });
  process.on('unhandledRejection', (e) => { log.error(`unhandledRejection: ${e?.message ?? e}`); publish('error', { source: 'unhandledRejection', message: String(e?.message ?? e) }); });
  await relay.start();

  // ---- health.json (호스트 OTA 확인 조건) ----
  const stopHealth = startHealthWriter(config.healthDir, () => ({ bootId: BOOT_ID, version: config.version, engineOnline: engineOnline(), deviceCount: api.listSiotDevices().length, relay: { connected: relay.connected } }));

  // ---- Matter 백엔드 ----
  matter.on('node_added', (n) => registry.upsertNode(n));
  matter.on('node_updated', (n) => registry.upsertNode(n));
  matter.on('node_removed', (id) => registry.removeNode(id));
  matter.on('attribute_updated', ([nodeId, p, v]) => registry.applyAttribute(nodeId, p, v));
  matter.on('node_event', (ev) => log.debug('node_event', ev));
  matter.on('disconnected', () => publish('gateway', { engineOnline: false }));
  const sync = async () => {
    const nodes = await matter.startListening();
    for (const n of nodes ?? []) registry.upsertNode(n);
    log.info(`synced ${nodes?.length ?? 0} nodes; thread_credentials_set=${matter.serverInfo?.thread_credentials_set} ble=${matter.serverInfo?.bluetooth_enabled}`);
    publish('gateway', { engineOnline: engineOnline(), deviceCount: api.listSiotDevices().length, threadCredentialsSet: Boolean(matter.serverInfo?.thread_credentials_set) });
  };
  const connectMatter = async () => {
    for (let attempt = 1; ; attempt++) {
      try { await matter.connect(); await sync(); return; }
      catch (e) { const d = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)); log.warn(`matter backend not ready (${e.message}); retry in ${d}ms`); if (attempt === 1) publish('error', { source: 'matter', message: e.message }); await new Promise((r) => setTimeout(r, d)); }
    }
  };
  await connectMatter();
  matter.on('reconnected', () => sync().catch((e) => log.error('resync failed', e.message)));

  // ---- OTBR 데이터셋 자동 등록 ----
  const stopSync = config.otbrRestUrl && !matter.isSim
    ? startDatasetSync({ restUrl: config.otbrRestUrl, matter, pairing, onRegistered: (bytes) => publish('thread', { datasetRegistered: true, bytes }) })
    : () => {};

  const shutdown = async () => { log.info('shutting down'); stopSync(); stopMdns(); stopHealth(); relay.stop(); await api.close(); matter.close?.(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.error('fatal', e.stack ?? e.message); process.exit(1); });
