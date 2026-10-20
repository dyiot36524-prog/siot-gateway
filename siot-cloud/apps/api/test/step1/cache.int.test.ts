// StateCache replay 규칙(§2 b, C1 백엔드 측) — 실제 Postgres.
import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { devices, events, gateways, siteKeys, webhookDeliveries, webhooks } from '../../src/db/schema.js';
import { createStateCache } from '../../src/cache/index.js';
import { PgOutbox } from '../../src/webhooks/Outbox.js';
import { encryptSecret } from '../../src/auth/secretBox.js';
import { newId } from '../../src/ids.js';
import { BOOT_A, BOOT_B, evtDevice, plug, seedGateway, seedOrg, seedSite, snapshot, testConfig, useTestDb } from './helpers.js';

const t = useTestDb();

async function setup() {
  await t.truncate();
  const orgId = await seedOrg(t.db);
  const siteId = await seedSite(t.db, orgId);
  const gw = await seedGateway(t.db, orgId, siteId, 1);
  await t.db.insert(webhooks).values({
    webhookId: newId('wh'),
    orgId,
    url: 'http://127.0.0.1:9/hook',
    secretEnc: encryptSecret('whsec_x', testConfig.DATA_ENC_KEY),
    events: ['device.state_changed', 'device.removed', 'gateway.online', 'gateway.offline'],
  });
  const outbox = new PgOutbox(t.db);
  const cache = await createStateCache({ db: t.db, outbox });
  await cache.setGatewayOnline(gw, true);
  return { orgId, siteId, gw, cache, outbox };
}

const deliveries = () => t.db.select().from(webhookDeliveries).orderBy(asc(webhookDeliveries.createdAt));

describe('StateCache replay rules', () => {
  beforeEach(async () => {
    await t.truncate();
  });

  it('snapshot → evt 반영, write-through(devices 행), deviceId 는 dev_ULID 로 유지', async () => {
    const { gw, siteId, cache } = await setup();
    await cache.applySnapshot(gw, snapshot(BOOT_A, 0, [plug('matter:5:1', false)]));
    const [d] = cache.getSiteDevices(siteId);
    expect(d!.deviceId).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    const r = await cache.applyEvt(gw, evtDevice(BOOT_A, 1, [plug('matter:5:1', true)]));
    expect(r).toMatchObject({ recorded: 1, stale: false });
    expect(cache.getDevice(d!.deviceId)!.data.switch).toBe(true);
    const [row] = await t.db.select().from(devices).where(eq(devices.deviceId, d!.deviceId));
    expect(row!.data).toEqual({ switch: true });
    expect(row!.siteId).toBe(siteId);
  });

  it('(gatewayId,bootId,seq,sub) 중복 evt 는 무시한다', async () => {
    const { gw, cache } = await setup();
    await cache.applySnapshot(gw, snapshot(BOOT_A, 0, [plug('matter:5:1', false)]));
    expect((await cache.applyEvt(gw, evtDevice(BOOT_A, 1, [plug('matter:5:1', true)]))).recorded).toBe(1);
    const dup = await cache.applyEvt(gw, evtDevice(BOOT_A, 1, [plug('matter:5:1', false)], { replayed: true }));
    expect(dup.recorded).toBe(0);
    expect(cache.getDeviceByLocal(gw, 'matter:5:1')!.data.switch).toBe(true);
    expect(await t.db.select().from(events)).toHaveLength(1);
    expect((await deliveries()).filter((x) => x.eventType === 'device.state_changed')).toHaveLength(1);
  });

  it('seq ≤ snapshot.seq 인 replay evt 는 캐시에 반영하지 않지만 미기록분이면 events·웹훅(replayed:true)에는 넣는다', async () => {
    const { gw, cache } = await setup();
    await cache.applySnapshot(gw, snapshot(BOOT_A, 5, [plug('matter:5:1', true)]));
    const r = await cache.applyEvt(gw, evtDevice(BOOT_A, 4, [plug('matter:5:1', false)], { replayed: true }));
    expect(r).toMatchObject({ stale: true, recorded: 1 });
    expect(cache.getDeviceByLocal(gw, 'matter:5:1')!.data.switch).toBe(true);
    const [ev] = await t.db.select().from(events);
    expect(ev).toMatchObject({ seq: 4, sub: 0, replayed: true });
    const [d] = await deliveries();
    expect(d!.payload).toMatchObject({ type: 'device.state_changed', replayed: true, seq: 4, data: { source: 'event', device: { data: { switch: false } } } });
    // seq > snapshot.seq 는 반영
    await cache.applyEvt(gw, evtDevice(BOOT_A, 6, [plug('matter:5:1', false)]));
    expect(cache.getDeviceByLocal(gw, 'matter:5:1')!.data.switch).toBe(false);
  });

  it('bootId 변경 시 이전 캐시와 snapshot 차이를 resync 이벤트로 합성(sub=1..k, deviceId 정렬), 같은 snapshot 재전송은 중복 제거', async () => {
    const { gw, cache } = await setup();
    await cache.applySnapshot(gw, snapshot(BOOT_A, 0, [plug('matter:5:1', false), plug('matter:6:1', false), plug('matter:7:1', true)]));
    const ids = ['matter:5:1', 'matter:6:1', 'matter:7:1'].map((l) => cache.getDeviceByLocal(gw, l)!.deviceId);
    // 재시작: 5 는 켜짐, 6 은 그대로, 7 은 사라짐, 8 은 새로
    const next = snapshot(BOOT_B, 3, [plug('matter:5:1', true), plug('matter:6:1', false), plug('matter:8:1', false)]);
    const r = await cache.applySnapshot(gw, next);
    expect(r.recorded).toBe(3);
    const evs = await t.db.select().from(events).where(eq(events.bootId, BOOT_B)).orderBy(asc(events.sub));
    expect(evs.map((e) => [e.seq, e.sub, e.kind])).toEqual([
      [3, 1, 'resync'],
      [3, 2, 'resync'],
      [3, 3, 'resync'],
    ]);
    const new8 = cache.getDeviceByLocal(gw, 'matter:8:1')!.deviceId;
    const expectedOrder = [ids[0]!, ids[2]!, new8].sort();
    const subjects = evs.map((e) => ((e.data as { device?: { deviceId: string }; deviceId?: string }).device?.deviceId ?? (e.data as { deviceId: string }).deviceId));
    expect(subjects).toEqual(expectedOrder);
    const hooks = (await deliveries()).map((d) => d.payload as { type: string; data: { source?: string } });
    expect(hooks.filter((h) => h.type === 'device.state_changed' && h.data.source === 'resync')).toHaveLength(2);
    expect(hooks.filter((h) => h.type === 'device.removed')).toHaveLength(1);
    expect(cache.getDeviceByLocal(gw, 'matter:7:1')).toBeUndefined();

    // 같은 snapshot 재전송 → 같은 키 → 0건
    const again = await cache.applySnapshot(gw, next);
    expect(again.recorded).toBe(0);
    // 같은 bootId 재접속 snapshot 은 resync 를 만들지 않는다
    const same = await cache.applySnapshot(gw, snapshot(BOOT_B, 4, [plug('matter:5:1', false), plug('matter:6:1', false), plug('matter:8:1', false)]));
    expect(same.recorded).toBe(0);
    expect(cache.getDeviceByLocal(gw, 'matter:5:1')!.data.switch).toBe(false);
  });

  it('keyVersion → site_keys.epoch 로 events.site_epoch 귀속(옛 keyVersion replay 는 옛 epoch)', async () => {
    const { gw, siteId, cache } = await setup();
    await t.db.insert(siteKeys).values([
      { siteId, version: 1, keyEnc: 'v1.x.y.z', epoch: 1, retiredAt: new Date() },
      { siteId, version: 2, keyEnc: 'v1.x.y.z', epoch: 2 },
    ]);
    await cache.applySnapshot(gw, snapshot(BOOT_A, 0, [plug('matter:5:1', false)], 2));
    await cache.applyEvt(gw, evtDevice(BOOT_A, 1, [plug('matter:5:1', true)], { keyVersion: 1, replayed: true }));
    await cache.applyEvt(gw, evtDevice(BOOT_A, 2, [plug('matter:5:1', false)], { keyVersion: 2 }));
    const evs = await t.db.select().from(events).orderBy(asc(events.seq));
    expect(evs.map((e) => [e.seq, e.keyVersion, e.siteEpoch])).toEqual([
      [1, 1, 1],
      [2, 2, 2],
    ]);
    const payloads = (await deliveries()).map((d) => d.payload as { seq: number; siteEpoch: number });
    expect(payloads.map((p) => [p.seq, p.siteEpoch])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('snapshot 전 evt 는 반영하지 않는다, offline 이면 조회 기기 online=false, 재기동 직후 전 GW offline', async () => {
    const { gw, siteId, cache } = await setup();
    await cache.applySnapshot(gw, snapshot(BOOT_A, 0, [plug('matter:5:1', false)]));
    await cache.setGatewayOnline(gw, false);
    expect(cache.getSiteDevices(siteId)[0]!.online).toBe(false);
    await cache.setGatewayOnline(gw, true);
    // 재접속했지만 아직 snapshot 이 없음 → evt 는 기록만
    expect((await cache.applyEvt(gw, evtDevice(BOOT_A, 1, [plug('matter:5:1', true)]))).stale).toBe(true);
    expect(cache.getSiteDevices(siteId)[0]!.data.switch).toBe(false);

    const [before] = await t.db.select().from(gateways).where(eq(gateways.gatewayId, gw));
    expect(before!.online).toBe(true);
    const restarted = await createStateCache({ db: t.db });
    expect(restarted.isGatewayOnline(gw)).toBe(false);
    expect(restarted.getSiteDevices(siteId)[0]!.online).toBe(false);
    expect(restarted.getSiteDevices(siteId)[0]!.deviceId).toBe(cache.getSiteDevices(siteId)[0]!.deviceId);
    const [after] = await t.db.select().from(gateways).where(eq(gateways.gatewayId, gw));
    expect(after!.online).toBe(false);
    // 재기동 후 다른 bootId 의 snapshot 은 DB 에 남은 이전 캐시와 비교해 resync
    await restarted.setGatewayOnline(gw, true);
    const r = await restarted.applySnapshot(gw, snapshot(BOOT_B, 0, [plug('matter:5:1', true)]));
    expect(r.recorded).toBe(1);
  });

  it('device_removed evt 는 기기를 지우고 device.removed 웹훅을 넣는다. 이름·위치는 GW 값으로 덮지 않는다', async () => {
    const { gw, siteId, cache } = await setup();
    await cache.applySnapshot(gw, snapshot(BOOT_A, 0, [plug('matter:5:1', false)]));
    const id = cache.getDeviceByLocal(gw, 'matter:5:1')!.deviceId;
    await cache.updateDeviceMeta(id, { name: '거실 플러그', room: '거실' });
    await cache.applyEvt(gw, evtDevice(BOOT_A, 1, [plug('matter:5:1', true, { name: 'GRILLPLATS Plug' })]));
    expect(cache.getDevice(id)).toMatchObject({ name: '거실 플러그', room: '거실' });
    await cache.applyEvt(gw, { t: 'evt', bootId: BOOT_A, seq: 2, keyVersion: 0, kind: 'device_removed', at: new Date().toISOString(), data: { deviceId: 'matter:5', ids: ['matter:5:1'] } });
    expect(cache.getDevice(id)).toBeUndefined();
    expect(cache.getSiteDevices(siteId)).toHaveLength(0);
    const [row] = await t.db.select().from(devices).where(and(eq(devices.deviceId, id)));
    expect(row!.removedAt).not.toBeNull();
    expect((await deliveries()).at(-1)!.payload).toMatchObject({ type: 'device.removed', data: { deviceId: id } });
  });
});
