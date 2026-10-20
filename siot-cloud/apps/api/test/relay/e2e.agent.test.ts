// e2e: 실제 게이트웨이 에이전트(matter-gateway-poc/agent, MATTER_BACKEND=sim, SIOT_MODE=production)를 자식 프로세스로 띄워
// 이 릴레이(실제 Postgres repo)에 접속시킨다.
//  미등록 4403 → provision → challenge→hello→welcome→snapshot → claim(API) → bind→bound → 토큰 재접속 → cfg→cfg_ack→snapshot
//  → GatewayBus.request(GET /siot-app/api/v1/devices) 200
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type postgres from 'postgres';
import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { auditLog, gateways, organizations, sites, users } from '../../src/db/schema.js';
import type { SessionService, SessionUser } from '../../src/auth/session.js';
import type { AppApiDeps } from '../../src/appapi/index.js';
import { registerGatewayClaim } from '../../src/appapi/gateways.js';
import { registerRelay, type RelayHandle } from '../../src/relay/index.js';
import { createDbGatewayRepo } from '../../src/relay/repo.js';
import { claimSecretFor, sha256Hex } from '../../src/relay/crypto.js';
import { freshDb, MemCache, MemOutbox, pgAvailable, TEST_CONFIG, until } from './helpers.js';

const config = TEST_CONFIG as unknown as Config;
const agentDir = fileURLToPath(new URL('../../../../../matter-gateway-poc/agent/', import.meta.url));
const canRun = (await pgAvailable()) && existsSync(join(agentDir, 'src/index.js')) && existsSync(join(agentDir, 'node_modules/ws'));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

describe.skipIf(!canRun)('e2e: real gateway agent ↔ relay', () => {
  let db: Db;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let relay: RelayHandle;
  let agent: ChildProcess | undefined;
  let dir: string;
  const logs: string[] = [];
  const timeline: string[] = [];
  const cache = new MemCache();
  const outbox = new MemOutbox();
  const orgId = `org_${ulid()}`;
  const siteId = `site_${ulid()}`;
  const installer: SessionUser = { userId: `usr_${ulid()}`, orgId, role: 'installer', email: 'i@x', name: 'I' };

  beforeAll(async () => {
    ({ db, sql } = await freshDb('siot_relay_e2e'));
    await db.insert(organizations).values({ orgId, name: '설치사' });
    await db.insert(users).values({ ...installer, passwordHash: 'x' });
    await db.insert(sites).values({ siteId, orgId, name: '101호' });

    // timeline: cache 호출과 cfg_ack/bound 기록을 한 줄로
    const repo = createDbGatewayRepo(db, config.DATA_ENC_KEY);
    const tracedRepo = {
      ...repo,
      recordCfgAck: async (g: string, a: Parameters<typeof repo.recordCfgAck>[1]) => {
        timeline.push(`cfg_ack:${a.cfgVersion}`);
        return repo.recordCfgAck(g, a);
      },
      recordBound: async (g: string) => {
        timeline.push('bound');
        return repo.recordBound(g);
      },
    };
    const tracedCache = {
      applySnapshot: async (g: string, f: Parameters<MemCache['applySnapshot']>[1]) => {
        timeline.push(`snapshot:devices=${f.devices.length}:kv=${f.keyVersion}`);
        return cache.applySnapshot(g, f);
      },
      applyEvt: (g: string, f: Parameters<MemCache['applyEvt']>[1]) => cache.applyEvt(g, f),
      setGatewayOnline: async (g: string, on: boolean) => {
        timeline.push(`online:${on}`);
        return cache.setGatewayOnline(g, on);
      },
    };

    app = Fastify({ logger: false });
    await app.register(websocket);
    relay = await registerRelay(app, { repo: tracedRepo, cache: tracedCache, outbox, deployedAt: new Date(0), timing: { offlineGraceMs: 0 } });
    const sessions: SessionService = {
      login: async () => null,
      logout: async () => {},
      authenticate: async (req: FastifyRequest) => (req.headers['x-test-user'] === installer.userId ? installer : null),
      hashPassword: async (p) => p,
    };
    await registerGatewayClaim(app, { config, db, bus: relay, sessions, cache: {} } as unknown as AppApiDeps);
    await app.listen({ port: 0, host: '127.0.0.1' });
    dir = await mkdtemp(join(tmpdir(), 'siot-e2e-'));
  });

  afterAll(async () => {
    if (agent && agent.exitCode === null) {
      agent.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (agent.exitCode === null) agent.kill('SIGKILL');
    }
    await app?.close();
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (process.env.E2E_LOG) console.log(logs.join(''));
  });

  it('unregistered 4403 → provision → snapshot → claim → bind/bound → token reconnect → cfg/cfg_ack → snapshot → req 200', async () => {
    const port = (app.server.address() as { port: number }).port;
    const [lanPort, adminPort] = [await freePort(), await freePort()];
    agent = spawn(process.execPath, ['src/index.js'], {
      cwd: agentDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MATTER_BACKEND: 'sim',
        SIOT_MODE: 'production',
        SIOT_RELAY_URL: `ws://127.0.0.1:${port}/gateway`,
        SIOT_DATA_DIR: join(dir, 'siot'),
        DATA_DIR: join(dir, 'data'),
        HEALTH_DIR: join(dir, 'health'),
        RULES_FILE: join(dir, 'rules.json'),
        RULES_SEED_FILE: join(dir, 'none.json'),
        SIOT_SERIAL_FILE: join(dir, 'none-serial'),
        SIOT_MACHINE_ID_FILE: join(dir, 'none-machine-id'),
        OTBR_REST_URL: '',
        PORT: String(lanPort),
        LOCAL_ADMIN_PORT: String(adminPort),
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout!.on('data', (d) => logs.push(String(d)));
    agent.stderr!.on('data', (d) => logs.push(String(d)));
    const log = () => logs.join('');

    // 1) 장치 키가 생기고, 미등록이라 4403
    const gwFile = join(dir, 'siot', 'gateway.json');
    const ident = await until(
      () => {
        try {
          const j = JSON.parse(readFileSync(gwFile, 'utf8'));
          return j.gatewayId && j.deviceKey?.publicKey ? (j as { gatewayId: string; deviceKey: { publicKey: string } }) : null;
        } catch {
          return null;
        }
      },
      15_000,
      'agent gateway.json',
    );
    const gatewayId = ident.gatewayId;
    await until(() => log().includes('(4403)'), 15_000, 'agent 4403');

    // 2) 출고 등록(공개키 = gateway.json) → 재접속(백오프) 후 unbound 로 online, snapshot
    await db.insert(gateways).values({ gatewayId, shortId: gatewayId.slice(3, 11), orgId, pubkey: ident.deviceKey.publicKey });
    await until(() => relay.isOnline(gatewayId), 15_000, 'relay online (unbound)');
    await until(() => timeline.some((t) => t.startsWith('snapshot:')), 10_000, 'first snapshot');
    expect(timeline.find((t) => t.startsWith('snapshot:'))).toBe('snapshot:devices=2:kv=0');
    expect((await db.select().from(gateways).where(eq(gateways.gatewayId, gatewayId)))[0]).toMatchObject({ online: true, cfgAckedVersion: 0 });

    // 3) claim(라벨 수동 입력) → bind → bound
    const t0 = timeline.length;
    const res = await app.inject({
      method: 'POST',
      url: '/app/v1/gateways/claim',
      headers: { 'x-test-user': installer.userId },
      payload: { shortId: `siot-${gatewayId.slice(3, 11)}`, claimSecret: claimSecretFor(config.LABEL_MASTER_KEY, gatewayId), siteId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ gatewayId, siteId, status: 'bound' });
    expect(timeline.slice(t0)).toContain('bound');

    // 4) GW 가 토큰으로 재접속 → welcome.cfgVersion 1 > 0 → cfg → cfg_ack → (보류 해제) snapshot
    await until(() => timeline.slice(t0).some((t) => t.startsWith('snapshot:')), 15_000, 'snapshot after cfg');
    const after = timeline.slice(t0);
    const iAck = after.indexOf('cfg_ack:1');
    const iSnap = after.findIndex((t) => t.startsWith('snapshot:'));
    expect(iAck).toBeGreaterThanOrEqual(0);
    expect(iAck).toBeLessThan(iSnap);
    expect(after[iSnap]).toBe('snapshot:devices=2:kv=1');
    expect(after.filter((t) => t.startsWith('cfg_ack:'))).toEqual(['cfg_ack:1']); // cfg 는 접속 순서에서 한 번만
    const saved = JSON.parse(readFileSync(gwFile, 'utf8')) as { gatewayToken: string; siteId: string };
    const [row] = await db.select().from(gateways).where(eq(gateways.gatewayId, gatewayId));
    expect(saved.siteId).toBe(siteId);
    expect(row!.tokenHash).toBe(sha256Hex(saved.gatewayToken)); // 토큰 원문은 GW 만, DB 는 해시만
    expect(row).toMatchObject({ status: 'bound', cfgVersion: 1, cfgAckedVersion: 1, keyVersion: 1, online: true });
    const site = JSON.parse(readFileSync(join(dir, 'siot', 'site.json'), 'utf8')) as { cfgVersion: number; siteId: string; keys: Array<{ v: number }> };
    expect(site).toMatchObject({ cfgVersion: 1, siteId, keys: [{ v: 1 }] });
    // 토큰 접속이었다(재발급 경로를 타지 않음)
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, 'gateway.token_reissued'), eq(auditLog.targetId, gatewayId)))).toHaveLength(0);
    expect(log()).toMatch(/connected .*\(gatewayId=.*, bound\)/);

    // 5) 명령 터널: req → 로컬 API(127.0.0.1:3001, GW 가 자기 토큰 주입) → res
    const r = await relay.request(gatewayId, { method: 'GET', path: '/siot-app/api/v1/devices', headers: { accept: 'application/json' } }, 5000);
    expect(r.status).toBe(200);
    const body = JSON.parse(Buffer.from(r.body ?? '', 'base64').toString('utf8')) as unknown;
    const list = (Array.isArray(body) ? body : ((body as { data?: unknown[]; devices?: unknown[] }).data ?? (body as { devices?: unknown[] }).devices)) as Array<{ id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.map((d) => d.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^matter:/)]));

    // 6) 웹훅 원천: online(unbound), offline(rebind), online(bound) 순
    expect(outbox.types().slice(0, 3)).toEqual(['gateway.online', 'gateway.offline', 'gateway.online']);

    // 7) 종료 → offline
    agent.kill('SIGTERM');
    await until(() => !relay.isOnline(gatewayId), 10_000, 'offline after agent exit');
    await until(() => timeline[timeline.length - 1] === 'online:false', 5000, 'cache offline');
    if (process.env.E2E_LOG) console.log(`[e2e] timeline: ${timeline.join(' → ')}`);
  }, 60_000);
});
