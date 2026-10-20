// npm run admin -- <command> [--flags]
//   org:create --name
//   user:create --email --name --role installer|resident|operator [--org] [--password]
//   apikey:create --org [--name] [--mode live|test] [--scopes a,b] [--ttl-days 365]
//   apikey:revoke --id
//   gateway:provision --id gw_<uuid> --pubkey <b64url43> --org [--force]   (LABEL_MASTER_KEY, APP_ORIGIN 환경 변수)
//   gateway:claim-window --id [--hours 24]
//   gateway:transfer-org --id --org
import { parseArgs } from 'node:util';
import { createDb } from '../db/client.js';
import * as cmd from './commands.js';

const USAGE = `사용법: npm run admin -- <command> [--flags]
  org:create --name <이름>
  user:create --email <e> --name <n> --role installer|resident|operator [--org org_...] [--password ...]
  apikey:create --org org_... [--name n] [--mode live|test] [--scopes devices:read,devices:control,webhooks:manage] [--ttl-days 365]
  apikey:revoke --id key_...
  gateway:provision --id gw_<uuid> --pubkey <base64url 43자> --org org_... [--force]
  gateway:claim-window --id gw_... [--hours 24]
  gateway:transfer-org --id gw_... --org org_...`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string' },
      org: { type: 'string' },
      password: { type: 'string' },
      mode: { type: 'string' },
      scopes: { type: 'string' },
      'ttl-days': { type: 'string' },
      id: { type: 'string' },
      pubkey: { type: 'string' },
      hours: { type: 'string' },
      force: { type: 'boolean' },
    },
    strict: true,
  });
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new cmd.AdminError('DATABASE_URL 이 필요합니다');
  const { db, sql } = createDb(url, { max: 2 });
  const need = (k: keyof typeof v) => {
    const x = v[k];
    if (typeof x !== 'string' || !x) throw new cmd.AdminError(`--${k} 가 필요합니다`);
    return x;
  };
  try {
    let out: unknown;
    switch (command) {
      case 'org:create':
        out = await cmd.orgCreate(db, { name: need('name') });
        break;
      case 'user:create':
        out = await cmd.userCreate(db, { email: need('email'), name: v.name ?? '', role: need('role'), org: v.org, password: v.password });
        break;
      case 'apikey:create':
        out = await cmd.apikeyCreate(db, { org: need('org'), name: v.name, mode: v.mode, scopes: v.scopes, ttlDays: v['ttl-days'] ? Number(v['ttl-days']) : undefined });
        break;
      case 'apikey:revoke':
        out = await cmd.apikeyRevoke(db, { id: need('id') });
        break;
      case 'gateway:provision':
        out = await cmd.gatewayProvision(db, {
          id: need('id'),
          pubkey: need('pubkey'),
          org: need('org'),
          force: v.force,
          labelMasterKey: process.env.LABEL_MASTER_KEY ?? '',
          appOrigin: process.env.APP_ORIGIN ?? 'https://siot-cloud.fly.dev',
        });
        break;
      case 'gateway:claim-window':
        out = await cmd.gatewayClaimWindow(db, { id: need('id'), hours: v.hours ? Number(v.hours) : undefined });
        break;
      case 'gateway:transfer-org':
        out = await cmd.gatewayTransferOrg(db, { id: need('id'), org: need('org') });
        break;
      default:
        console.error(`알 수 없는 명령: ${command}\n${USAGE}`);
        return 1;
    }
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof cmd.AdminError || err instanceof RangeError ? `오류: ${err.message}` : err);
    process.exit(1);
  },
);
