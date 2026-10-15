import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './log.js';
import { createMatterBackend } from './matterBackend.js';
import { DeviceRegistry } from './model/registry.js';
import { executeCommand } from './commands.js';
import { PairingManager } from './pairing.js';
import { RulesEngine } from './rules.js';
import { CloudLink } from './mqtt.js';

const log = logger('agent');

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  const registry = new DeviceRegistry();
  const matter = await createMatterBackend();
  const cloud = new CloudLink({ url: config.mqttUrl, username: config.mqttUser, password: config.mqttPass, gatewayId: config.gatewayId });
  const pairing = new PairingManager(matter, registry);
  const execute = (cmd) => executeCommand(matter, registry, cmd);
  const rules = new RulesEngine(registry, execute, { file: config.rulesFile, publish: (t, p) => cloud.publish(t, p) });
  await rules.load();

  // ---- 레지스트리 → 클라우드 ----
  registry.on('device.added', (d) => cloud.publish(`device/${d.id}`, d, { retain: true }));
  registry.on('device.updated', (d) => cloud.publish(`device/${d.id}`, d, { retain: true }));
  registry.on('device.removed', (id) => { cloud.publish(`device/${id}`, {}, { retain: true }); cloud.publish(`device/${id}/removed`, { at: Date.now() }); });
  registry.on('state', (c) => cloud.publish(`device/${c.deviceId}/state`, c));
  pairing.on('progress', (p) => cloud.publish('pairing/event', p));

  // ---- 클라우드 → 게이트웨이 ----
  cloud.on('cmd', async (cmd) => {
    try { await execute(cmd); cloud.publish('cmd/result', { reqId: cmd.reqId, ok: true }); }
    catch (e) { cloud.publish('cmd/result', { reqId: cmd.reqId, ok: false, error: e.message }); }
  });
  cloud.on('pairing/start', (req) => pairing.start(req).catch(() => {}));
  cloud.on('pairing/open-window', async (req) => {
    try { const r = await pairing.openWindow(req.deviceId, req.timeout); cloud.publish('pairing/window', { reqId: req.reqId, ok: true, ...r }); }
    catch (e) { cloud.publish('pairing/window', { reqId: req.reqId, ok: false, error: e.message }); }
  });
  cloud.on('pairing/remove', async (req) => {
    try { await pairing.remove(req.deviceId); cloud.publish('cmd/result', { reqId: req.reqId, ok: true }); }
    catch (e) { cloud.publish('cmd/result', { reqId: req.reqId, ok: false, error: e.message }); }
  });
  cloud.on('rules/set', (req) => rules.replace(req.rules ?? [], path.join(config.dataDir, 'rules.json')));

  // ---- Matter 서버 이벤트 ----
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
  await matter.connect();
  await sync();
  matter.on('reconnected', () => sync().catch((e) => log.error('resync failed', e.message)));

  const shutdown = async () => { log.info('shutting down'); matter.close(); await cloud.end(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.error('fatal', e.stack ?? e.message); process.exit(1); });
