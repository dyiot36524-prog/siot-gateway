// e2e: 공개 API 로 저장한 자동화 규칙이 실제 게이트웨이 에이전트(matter-gateway-poc/agent, MATTER_BACKEND=sim, SIOT_MODE=production)에
// cfg 로 내려가 RULES_FILE 에 저장되고, 클라우드 경유 없이 에이전트 안에서 실행되는지.
//  buildApp(실제 relay·StateCache·Postgres) → provision → claim(세션 로그인) → bind → cfg/cfg_ack → snapshot
//  → PUT /v1/sites/{siteId}/automations(문 열림 → 플러그 ON) → rules.json v1 · appliedVersion 1
//  → 로컬 API POST /siot-app/api/v1/sim/door(문 열림) → 에이전트 규칙 발동 → evt → GET /v1/devices/{plug} data.switch true
//  → PUT rules [] → rules.json v2 · appliedVersion 2
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import type postgres from 'postgres';
import type { PublicDevice } from '@siot/protocol';
import { buildApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { devices, gateways } from '../../src/db/schema.js';
import { claimSecretFor } from '../../src/relay/crypto.js';
import { seedOrg, seedSite, seedUser, testConfig } from '../step1/helpers.js';
import { freshDb, pgAvailable, sleep, until } from './helpers.js';

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

/** 비동기 조건을 짧은 간격으로 폴링(상한 있음) */
async function poll<T>(fn: () => Promise<T | undefined | null | false>, ms: number, label: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

describe.skipIf(!canRun)('e2e: automation rules → real gateway agent (local execution)', () => {
  let db: Db;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let agent: ChildProcess | undefined;
  let dir: string;
  const logs: string[] = [];
  const timings: string[] = [];

  beforeAll(async () => {
    ({ db, sql } = await freshDb('siot_relay_e2e_automations'));
    app = await buildApp({ config: testConfig, db, logger: false, startWorkers: false, webDist: false, pingDb: async () => {}, deployedAt: new Date(0) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    dir = await mkdtemp(join(tmpdir(), 'siot-e2e-aut-'));
  });

  afterAll(async () => {
    if (agent && agent.exitCode === null) {
      const exited = new Promise((r) => agent!.once('exit', r));
      agent.kill('SIGTERM');
      await Promise.race([exited, sleep(2000)]);
      if (agent.exitCode === null) agent.kill('SIGKILL');
    }
    await app?.close();
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (process.env.E2E_LOG) console.log(logs.join(''));
    if (process.env.E2E_LOG) console.log(`[e2e automations] ${timings.join(', ')}`);
  });

  it('PUT automations → cfg → agent rules.json v1 → sim door open → agent turns plug ON → evt → public API; PUT [] → v2', async () => {
    const ctx = app.siot!;
    const orgId = await seedOrg(db);
    const siteId = await seedSite(db, orgId);
    const installer = await seedUser(db, 'installer', orgId);
    const apiKey = (await ctx.apiKeys.issue(orgId, { name: 'partner', mode: 'test', scopes: ['devices:read', 'devices:control'] })).key;
    const pub = (method: 'GET' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${apiKey}` }, ...(payload ? { payload } : {}) });

    // 1) 에이전트 기동(sim·출고 모드·임시 디렉터리) → gateway.json → 4403 → 출고 등록 → online
    const port = (app.server.address() as { port: number }).port;
    const [lanPort, adminPort] = [await freePort(), await freePort()];
    const rulesFile = join(dir, 'rules.json');
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
        RULES_FILE: rulesFile,
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

    const gwFile = join(dir, 'siot', 'gateway.json');
    const ident = await until(
      () => {
        const j = readJson<{ gatewayId?: string; deviceKey?: { publicKey?: string } }>(gwFile);
        return j?.gatewayId && j.deviceKey?.publicKey ? { gatewayId: j.gatewayId, publicKey: j.deviceKey.publicKey } : null;
      },
      15_000,
      'agent gateway.json',
    );
    const gatewayId = ident.gatewayId;
    await until(() => log().includes('(4403)'), 15_000, 'agent 4403');
    await db.insert(gateways).values({ gatewayId, shortId: gatewayId.slice(3, 11), orgId, pubkey: ident.publicKey });
    await until(() => ctx.bus.isOnline(gatewayId), 15_000, 'relay online (unbound)');

    // 2) 설치 기사 로그인 → claim → bind → 토큰 재접속 → cfg_ack 1 → snapshot(세대 기기 2개)
    const origin = testConfig.APP_ORIGIN;
    const login = await app.inject({ method: 'POST', url: '/app/v1/auth/login', headers: { origin }, payload: { email: installer.email, password: installer.password } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const claim = await app.inject({
      method: 'POST',
      url: '/app/v1/gateways/claim',
      headers: { origin, cookie },
      payload: { shortId: `siot-${gatewayId.slice(3, 11)}`, claimSecret: claimSecretFor(testConfig.LABEL_MASTER_KEY, gatewayId), siteId },
    });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json()).toMatchObject({ gatewayId, siteId, status: 'bound' });
    const devs = await poll(
      async () => {
        const r = await pub('GET', `/v1/sites/${siteId}/devices`);
        const list = r.statusCode === 200 ? (r.json().data as PublicDevice[]) : [];
        const plug = list.find((d) => d.deviceType === 'PLUG');
        const door = list.find((d) => d.deviceType === 'BINARY_SENSOR');
        return plug && door && ctx.bus.isOnline(gatewayId) ? { plug, door } : null;
      },
      15_000,
      'site devices (plug + door) after bind',
    );
    expect(devs.plug.data.switch).toBe(false); // sim 플러그는 꺼진 채 시작
    expect(devs.door.data).toMatchObject({ measurement: 'door', active: false }); // sim 도어는 닫힌 채 시작(BooleanState true)
    const local = await db.select({ deviceId: devices.deviceId, localId: devices.localId }).from(devices).where(inArray(devices.deviceId, [devs.plug.deviceId, devs.door.deviceId]));
    const localOf = (id: string) => local.find((d) => d.deviceId === id)?.localId;
    const [plugLocal, doorLocal] = [localOf(devs.plug.deviceId), localOf(devs.door.deviceId)];
    expect([plugLocal, doorLocal]).toEqual(['matter:1:1', 'matter:2:1']);

    // 3) PUT 규칙 1개(문 active → true 이면 플러그 ON) → version 1
    const rule = {
      name: '문 열리면 플러그 켜기',
      trigger: { type: 'device', deviceId: devs.door.deviceId, field: 'active', changedTo: true },
      actions: [{ type: 'command', deviceId: devs.plug.deviceId, action: 'ON' }],
    };
    const tPut = Date.now();
    const put1 = await pub('PUT', `/v1/sites/${siteId}/automations`, { rules: [rule] });
    expect(put1.statusCode, put1.body).toBe(200);
    const set1 = put1.json() as { version: number; rules: Array<{ id: string }> };
    expect(set1.version).toBe(1);
    const ruleId = set1.rules[0]!.id;

    // 에이전트 RULES_FILE 에 컴파일된 규칙(로컬 deviceId·capability)으로 저장
    const file1 = await until(() => readJson<{ version: number; rules: unknown[] }>(rulesFile)?.version === 1 && readJson<{ version: number; rules: unknown[] }>(rulesFile), 5000, 'rules.json v1');
    timings.push(`PUT→rules.json v1 ${Date.now() - tPut}ms`);
    expect(file1).toEqual({
      version: 1,
      rules: [
        {
          id: ruleId,
          name: '문 열리면 플러그 켜기',
          enabled: true,
          trigger: { type: 'device', deviceId: 'matter:2', endpoint: 1, capability: 'contact', field: 'open', changedTo: true },
          conditions: [],
          actions: [{ type: 'command', deviceId: 'matter:1', endpoint: 1, capability: 'onoff', action: 'on' }],
        },
      ],
    });
    // cfg_ack.rulesVersion → appliedVersion
    await poll(async () => (await pub('GET', `/v1/sites/${siteId}/automations`)).json().gateways?.[0]?.appliedVersion === 1, 5000, 'appliedVersion 1');
    timings.push(`PUT→appliedVersion 1 ${Date.now() - tPut}ms`);
    const got1 = (await pub('GET', `/v1/sites/${siteId}/automations`)).json();
    expect(got1).toMatchObject({ version: 1, gateways: [{ gatewayId, online: true, appliedVersion: 1 }] });

    // 4) sim 도어 열기(에이전트 loopback 관리 API, 게이트웨이 토큰) → 규칙이 에이전트 안에서 플러그 ON → evt → 공개 API
    const { gatewayToken } = readJson<{ gatewayToken: string }>(gwFile)!;
    expect(gatewayToken).toEqual(expect.any(String));
    const tDoor = Date.now();
    const door = await fetch(`http://127.0.0.1:${adminPort}/siot-app/api/v1/sim/door`, { method: 'POST', headers: { authorization: `Bearer ${gatewayToken}` } });
    expect(door.status).toBe(200);
    expect(await door.json()).toMatchObject({ ok: true, nodeId: 2, closed: false });
    const plugOn = await poll(
      async () => {
        const r = await pub('GET', `/v1/devices/${devs.plug.deviceId}`);
        return r.statusCode === 200 && (r.json() as PublicDevice).data.switch === true ? (r.json() as PublicDevice) : null;
      },
      5000,
      'plug switch true via evt',
    );
    timings.push(`door→plug ON (public API) ${Date.now() - tDoor}ms`);
    expect(plugOn).toMatchObject({ deviceId: devs.plug.deviceId, online: true, data: { switch: true } });
    expect(ctx.cache.getDevice(devs.door.deviceId)!.data.active).toBe(true);
    expect(log()).toContain(`rule fired: ${ruleId}`);

    // 5) PUT rules [] → version 2 → rules.json {version:2, rules:[]} · appliedVersion 2
    const tPut2 = Date.now();
    const put2 = await pub('PUT', `/v1/sites/${siteId}/automations`, { rules: [] });
    expect(put2.statusCode, put2.body).toBe(200);
    expect(put2.json()).toMatchObject({ version: 2, rules: [] });
    await until(() => readJson<{ version: number }>(rulesFile)?.version === 2, 5000, 'rules.json v2');
    timings.push(`PUT[]→rules.json v2 ${Date.now() - tPut2}ms`);
    expect(readJson(rulesFile)).toEqual({ version: 2, rules: [] });
    await poll(async () => (await pub('GET', `/v1/sites/${siteId}/automations`)).json().gateways?.[0]?.appliedVersion === 2, 5000, 'appliedVersion 2');
  }, 60_000);
});
