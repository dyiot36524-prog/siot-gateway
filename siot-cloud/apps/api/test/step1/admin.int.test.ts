// 운영자 CLI 명령(commands.ts) + api_key.expiring + 비밀 암호화 포맷 호환(relay/crypto).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { apiKeys, auditLog, gateways, users, webhookDeliveries, webhooks } from '../../src/db/schema.js';
import * as admin from '../../src/admin/commands.js';
import { decryptSecret, encryptSecret } from '../../src/auth/secretBox.js';
import { decryptSecret as relayDecrypt, encryptSecret as relayEncrypt, claimSecretMatches } from '../../src/relay/crypto.js';
import { PgOutbox } from '../../src/webhooks/Outbox.js';
import { WebhookWorker } from '../../src/webhooks/worker.js';
import { newId } from '../../src/ids.js';
import { TEST_DB_URL, testConfig, useTestDb } from './helpers.js';

const t = useTestDb();
const GW = 'gw_739f694e-76be-5888-be41-639544c21b5b';
const PUB = 'MCowBQYDK2VwAyEAvH7rS0b1Ff4G2xQ1oQe0Jb3m9QZ';

describe('admin CLI', () => {
  it('org:create → user:create → apikey:create → gateway:provision(라벨 secret) → claim-window → transfer-org', async () => {
    await t.truncate();
    const { orgId } = await admin.orgCreate(t.db, { name: '시옷플랫폼' });
    expect(orgId).toMatch(/^org_/);
    const u = await admin.userCreate(t.db, { email: 'kisa@example.com', name: '기사', role: 'installer', org: orgId });
    expect(u.password).toHaveLength(16);
    const [row] = await t.db.select().from(users).where(eq(users.userId, u.userId));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(admin.userCreate(t.db, { email: 'x@example.com', name: 'x', role: 'installer' })).rejects.toThrow(/--org/);

    const key = await admin.apikeyCreate(t.db, { org: orgId, name: 'partner', mode: 'live', scopes: 'devices:read,devices:control' });
    expect(key.key).toMatch(/^sk_live_[0-9A-Za-z]{32}$/);
    await admin.apikeyCreate(t.db, { org: orgId });
    await expect(admin.apikeyCreate(t.db, { org: orgId })).rejects.toThrow(/2개/);

    const p = await admin.gatewayProvision(t.db, { id: GW, pubkey: PUB, org: orgId, labelMasterKey: testConfig.LABEL_MASTER_KEY, appOrigin: 'https://siot-cloud.fly.dev' });
    expect(p).toMatchObject({ shortId: '739f694e', label: 'siot-739f694e' });
    expect(p.claimSecret).toMatch(/^[0-9a-f]{16}$/);
    expect(p.labelCode).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(p.qrUrl).toBe(`https://siot-cloud.fly.dev/g/${GW}#${p.claimSecret}`);
    expect(claimSecretMatches(testConfig.LABEL_MASTER_KEY, GW, p.labelCode)).toBe(true); // relay claim 검증과 같은 값
    // 멱등 + 다른 키는 --force 필요
    expect((await admin.gatewayProvision(t.db, { id: GW, pubkey: PUB, org: orgId, labelMasterKey: testConfig.LABEL_MASTER_KEY, appOrigin: 'x' })).action).toBe('gateway.provision_repeat');
    const other = 'B'.repeat(43);
    await expect(admin.gatewayProvision(t.db, { id: GW, pubkey: other, org: orgId, labelMasterKey: testConfig.LABEL_MASTER_KEY, appOrigin: 'x' })).rejects.toThrow(/--force/);
    await admin.gatewayProvision(t.db, { id: GW, pubkey: other, org: orgId, labelMasterKey: testConfig.LABEL_MASTER_KEY, appOrigin: 'x', force: true });
    await expect(admin.gatewayProvision(t.db, { id: 'gw_bad', pubkey: PUB, org: orgId, labelMasterKey: testConfig.LABEL_MASTER_KEY, appOrigin: 'x' })).rejects.toThrow(/gw_<uuid>/);

    const now = new Date('2026-10-21T00:00:00Z');
    const w = await admin.gatewayClaimWindow(t.db, { id: GW, now });
    expect(w.claimWindowUntil).toBe('2026-10-22T00:00:00.000Z');
    const { orgId: org2 } = await admin.orgCreate(t.db, { name: 'B' });
    await admin.gatewayTransferOrg(t.db, { id: GW, org: org2 });
    const [g] = await t.db.select().from(gateways).where(eq(gateways.gatewayId, GW));
    expect(g).toMatchObject({ orgId: org2, pubkey: other, status: 'unbound' });
    const actions = (await t.db.select().from(auditLog).orderBy(asc(auditLog.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['org.create', 'user.create', 'apikey.create', 'gateway.provision', 'gateway.pubkey_replaced', 'gateway.claim_window_open', 'gateway.transfer_org']));
  });

  it('npm run admin -- 실행(프로세스)', () => {
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    const out = execFileSync('npx', ['tsx', 'src/admin/cli.ts', 'org:create', '--name', 'CLI 조직'], { cwd, env: { ...process.env, DATABASE_URL: TEST_DB_URL }, encoding: 'utf8' });
    expect(JSON.parse(out).orgId).toMatch(/^org_/);
  }, 30_000);

  it('api_key.expiring: 만료 30일 전 키에 1회', async () => {
    await t.truncate();
    const { orgId } = await admin.orgCreate(t.db, { name: 'O' });
    const k = await admin.apikeyCreate(t.db, { org: orgId, ttlDays: 20 });
    await admin.apikeyCreate(t.db, { org: orgId, ttlDays: 365 });
    await t.db.insert(webhooks).values({ webhookId: newId('wh'), orgId, url: 'https://p.example.com', secretEnc: encryptSecret('s', testConfig.DATA_ENC_KEY), events: ['api_key.expiring'] });
    const outbox = new PgOutbox(t.db);
    const worker = new WebhookWorker({ db: t.db, encKey: testConfig.DATA_ENC_KEY, outbox, log: console, pollMs: 0 });
    expect(await worker.notifyExpiringKeys()).toBe(1);
    expect(await worker.notifyExpiringKeys()).toBe(0);
    const [d] = await t.db.select().from(webhookDeliveries);
    expect(d!.payload).toMatchObject({ type: 'api_key.expiring', data: { prefix: k.prefix } });
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.apiKeyId, k.apiKeyId));
    expect(row!.expiringNotifiedAt).not.toBeNull();
  });

  it('secretBox 포맷은 relay/crypto 와 상호 호환', () => {
    const k = testConfig.DATA_ENC_KEY;
    const a = encryptSecret('whsec_abc', k);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]*\.[\w-]+$/);
    expect(relayDecrypt(k, a).toString('utf8')).toBe('whsec_abc');
    expect(decryptSecret(relayEncrypt(k, Buffer.from('hello')), k)).toBe('hello');
  });
});
