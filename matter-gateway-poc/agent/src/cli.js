#!/usr/bin/env node
// 1주차 검증용 CLI. 예:
//   node src/cli.js info
//   node src/cli.js dataset 0e080000000000010000000300001235...   (ot-ctl dataset active -x)
//   node src/cli.js pair "MT:Y.K9042C00KA0648G00"                (IKEA 포장/기기 QR)
//   node src/cli.js pair 34970112332                             (수동 페어링 코드)
//   node src/cli.js nodes | devices | watch
//   node src/cli.js on matter:1 1 | off matter:1 1 | toggle matter:1 1
//   node src/cli.js window matter:1      (멀티 어드민용 커미셔닝 창 열기)
//   node src/cli.js remove matter:1
//   node src/cli.js raw get_thread_border_routers '{}'
import { config } from './config.js';
import { createMatterBackend } from './matterBackend.js';
import { DeviceRegistry } from './model/registry.js';
import { executeCommand } from './commands.js';
import { PairingManager } from './pairing.js';

const [cmd, ...args] = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

async function main() {
  const matter = await createMatterBackend();
  const registry = new DeviceRegistry();
  const pairing = new PairingManager(matter, registry);
  pairing.on('progress', (p) => console.error(`[pairing] ${p.stage}${p.error ? ' ' + p.error : ''}`));
  await matter.connect();
  const load = async () => { for (const n of (await matter.getNodes()) ?? []) registry.upsertNode(n); };

  switch (cmd) {
    case 'info': out(matter.serverInfo); break;
    case 'dataset': out(await pairing.setThreadDataset(args[0], args[1])); break;
    case 'pair': out(await pairing.start({ sessionId: `cli-${Date.now()}`, code: args[0] })); break;
    case 'nodes': out(await matter.getNodes()); break;
    case 'devices': await load(); out(registry.list()); break;
    case 'on': case 'off': case 'toggle':
      await load();
      out(await executeCommand(matter, registry, { deviceId: args[0], endpoint: args[1] ? Number(args[1]) : undefined, capability: 'onoff', action: cmd }));
      break;
    case 'window': await load(); out(await pairing.openWindow(args[0], Number(args[1] ?? 300))); break;
    case 'remove': await load(); await pairing.remove(args[0]); out({ removed: args[0] }); break;
    case 'raw': out(await matter.request(args[0], args[1] ? JSON.parse(args[1]) : undefined)); break;
    case 'watch': {
      await load();
      matter.on('attribute_updated', ([nodeId, p, v]) => { const c = registry.applyAttribute(nodeId, p, v); if (c) out(c); else console.error(`raw ${nodeId} ${p} =`, v); });
      matter.on('node_updated', (n) => registry.upsertNode(n));
      await matter.startListening();
      console.error('watching... (Ctrl+C)');
      return; // keep alive
    }
    default:
      console.error('usage: cli <info|dataset|pair|nodes|devices|on|off|toggle|window|remove|raw|watch> ...');
      process.exitCode = 2;
  }
  matter.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
