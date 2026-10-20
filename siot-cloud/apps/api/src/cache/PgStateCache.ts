// StateCache 구현: 인메모리 Map + Postgres write-through(gateways·devices·events, 웹훅 outbox 는 같은 트랜잭션).
// 게이트웨이마다 직렬화(snapshot·evt·online 이 도착 순서대로 처리되고, DB 기록 후 resolve → relay 는 그 뒤 ack).
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { EvtFrame, PublicDevice, SiotDevice, SnapshotFrame } from '@siot/protocol';
import type { Db } from '../db/client.js';
import { devices, events, gateways, siteKeys, sites } from '../db/schema.js';
import { newId } from '../ids.js';
import type { Tx, WebhookEvent } from '../webhooks/Outbox.js';
import type {
  ApplyResult,
  CacheEvent,
  DeviceListener,
  DeviceRef,
  GatewayStatusValue,
  GatewayView,
  StateCache,
} from './StateCache.js';

type DeviceDataValue = string | number | boolean | null;
type DeviceDataMap = Record<string, DeviceDataValue>;

interface DevState {
  deviceId: string;
  gatewayId: string;
  localId: string;
  name: string;
  room: string | null;
  deviceType: PublicDevice['deviceType'];
  data: DeviceDataMap;
  online: boolean;
  vendor: string | null;
  model: string | null;
  lastUpdated: string;
}

interface GwState {
  gatewayId: string;
  shortId: string;
  orgId: string;
  siteId: string | null;
  status: GatewayStatusValue;
  online: boolean;
  lastSeenAt: Date | null;
  agentVersion: string | null;
  matterServerVersion: string | null;
  lastErrorCode: string | null;
  claimWindowUntil: Date | null;
  bootId: string | null;
  keyVersion: number;
  /** 이 프로세스에서 마지막으로 받은 snapshot(없으면 null → 모든 evt 미반영) */
  snapshotBootId: string | null;
  snapshotSeq: number;
  /** localId → deviceId (제거되지 않은 기기) */
  devices: Map<string, string>;
}

/** outbox 중 캐시가 쓰는 부분 */
export interface CacheOutbox {
  enqueue(orgId: string, event: WebhookEvent, tx?: Tx): Promise<void>;
  kick(): void;
}

export interface PgStateCacheOptions {
  db: Db;
  outbox?: CacheOutbox;
  log?: Pick<FastifyBaseLogger, 'warn' | 'error'>;
  now?: () => Date;
  onOnlineCount?: (n: number) => void;
}

const EMPTY: ApplyResult = { changed: [], recorded: 0, stale: false };

function toData(d: SiotDevice['data']): DeviceDataMap {
  const out: DeviceDataMap = {};
  for (const [k, v] of Object.entries(d ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

function sameData(a: DeviceDataMap, b: DeviceDataMap): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

function sameState(a: DevState, b: DevState): boolean {
  return a.deviceType === b.deviceType && a.online === b.online && a.vendor === b.vendor && a.model === b.model && sameData(a.data, b.data);
}

function isoOr(s: string, fallback: Date): Date {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class PgStateCache implements StateCache {
  private readonly gws = new Map<string, GwState>();
  private readonly devs = new Map<string, DevState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly deviceListeners = new Set<DeviceListener>();
  private readonly eventListeners = new Set<(ev: CacheEvent) => void>();
  private readonly epochs = new Map<string, number>();
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(private readonly opts: PgStateCacheOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  /** DB 에서 gateways·devices 를 읽는다. 모든 GW 는 offline 으로 시작(재기동 직후 접속 확인 전). */
  async load(): Promise<void> {
    await this.db.update(gateways).set({ online: false }).where(eq(gateways.online, true));
    const gwRows = await this.db.select().from(gateways);
    for (const r of gwRows) this.syncGw(r);
    const devRows = await this.db.select().from(devices).where(sql`${devices.removedAt} is null`);
    for (const r of devRows) {
      const gw = this.gws.get(r.gatewayId);
      if (!gw) continue;
      this.devs.set(r.deviceId, {
        deviceId: r.deviceId,
        gatewayId: r.gatewayId,
        localId: r.localId,
        name: r.name,
        room: r.room,
        deviceType: r.deviceType as DevState['deviceType'],
        data: r.data,
        online: r.online,
        vendor: r.vendor,
        model: r.model,
        lastUpdated: r.lastUpdated.toISOString(),
      });
      gw.devices.set(r.localId, r.deviceId);
    }
    this.opts.onOnlineCount?.(0);
  }

  // ---------------- 조회(캐시만) ----------------

  getDevice(deviceId: string): PublicDevice | undefined {
    const d = this.devs.get(deviceId);
    return d ? this.pub(d) : undefined;
  }

  getDeviceByLocal(gatewayId: string, localId: string): PublicDevice | undefined {
    const id = this.gws.get(gatewayId)?.devices.get(localId);
    return id ? this.getDevice(id) : undefined;
  }

  getSiteDevices(siteId: string): PublicDevice[] {
    const out: PublicDevice[] = [];
    for (const gw of this.gws.values()) {
      if (gw.siteId !== siteId) continue;
      for (const id of gw.devices.values()) {
        const d = this.devs.get(id);
        const p = d && this.pub(d);
        if (p) out.push(p);
      }
    }
    return out.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  }

  resolveDevice(deviceId: string): DeviceRef | undefined {
    const d = this.devs.get(deviceId);
    if (!d) return undefined;
    return { deviceId, gatewayId: d.gatewayId, localId: d.localId, siteId: this.gws.get(d.gatewayId)?.siteId ?? null };
  }

  getGateway(gatewayId: string): GatewayView | undefined {
    const g = this.gws.get(gatewayId);
    return g ? this.view(g) : undefined;
  }

  getSiteGateways(siteId: string): GatewayView[] {
    return [...this.gws.values()]
      .filter((g) => g.siteId === siteId)
      .map((g) => this.view(g))
      .sort((a, b) => (a.gatewayId < b.gatewayId ? -1 : 1));
  }

  isGatewayOnline(gatewayId: string): boolean {
    return this.gws.get(gatewayId)?.online ?? false;
  }

  subscribe(listener: DeviceListener): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  subscribeEvents(listener: (ev: CacheEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ---------------- 갱신 ----------------

  applySnapshot(gatewayId: string, frame: SnapshotFrame): Promise<ApplyResult> {
    return this.serial(gatewayId, async () => {
      const [row] = await this.db.select().from(gateways).where(eq(gateways.gatewayId, gatewayId)).limit(1);
      if (!row) {
        this.opts.log?.warn({ gatewayId }, 'snapshot from unknown gateway ignored');
        return EMPTY;
      }
      const gw = this.syncGw(row);
      const restarted = gw.bootId !== null && gw.bootId !== frame.bootId;
      const t = this.now();
      const plan = frame.devices.map((sd) => {
        const id = gw.devices.get(sd.id);
        return { sd, prev: id ? this.devs.get(id) : undefined };
      });
      const incoming = new Set(frame.devices.map((d) => d.id));
      const removed = [...gw.devices].filter(([local]) => !incoming.has(local)).map(([, id]) => id);
      const siteEpoch = await this.epochFor(gw.siteId, frame.keyVersion);
      const g = frame.gateway;

      const out = await this.db.transaction(async (tx) => {
        await tx
          .update(gateways)
          .set({
            bootId: frame.bootId,
            agentVersion: g.agentVersion,
            matterServerVersion: g.matterServerVersion ?? null,
            lastErrorCode: g.lastErrorCode ?? null,
            keyVersion: frame.keyVersion,
            lastSeenAt: t,
          })
          .where(eq(gateways.gatewayId, gatewayId));
        const next = await this.upsertDevices(tx, gw, plan, t);
        if (removed.length) await tx.update(devices).set({ removedAt: t }).where(inArray(devices.deviceId, removed));
        const changed = next.filter((n, i) => !plan[i]!.prev || !sameState(plan[i]!.prev!, n));

        let recorded = 0;
        if (restarted) {
          // 재시작으로 링버퍼가 사라졌다 → 이전 캐시와 snapshot 의 차이를 resync 이벤트로 합성(sub = deviceId 정렬 순번)
          const items = [
            ...changed.map((d) => ({ id: d.deviceId, dev: d as DevState | null })),
            ...removed.map((id) => ({ id, dev: null as DevState | null })),
          ].sort((a, b) => (a.id < b.id ? -1 : 1));
          if (items.length) {
            const rows = items.map((it, i) => ({
              eventId: newId('evt'),
              gatewayId,
              bootId: frame.bootId,
              seq: frame.seq,
              sub: i + 1,
              siteId: gw.siteId,
              siteEpoch,
              keyVersion: frame.keyVersion,
              kind: 'resync',
              at: t,
              replayed: false,
              data: it.dev ? { device: this.pubOf(it.dev, gw.siteId ?? '', true) } : { deviceId: it.id, removed: true },
            }));
            const ins = await tx.insert(events).values(rows).onConflictDoNothing().returning({ eventId: events.eventId, sub: events.sub });
            recorded = ins.length;
            if (gw.siteId && siteEpoch !== null) {
              for (const r of ins) {
                const it = items[r.sub - 1]!;
                const order = { gatewayId, siteId: gw.siteId, siteEpoch, bootId: frame.bootId, seq: frame.seq };
                const ev: WebhookEvent = it.dev
                  ? { eventId: r.eventId, type: 'device.state_changed', createdAt: t.toISOString(), replayed: false, ...order, data: { device: this.pubOf(it.dev, gw.siteId, true), source: 'resync', at: t.toISOString() } }
                  : { eventId: r.eventId, type: 'device.removed', createdAt: t.toISOString(), replayed: false, ...order, data: { deviceId: it.id } };
                await this.opts.outbox?.enqueue(gw.orgId, ev, tx);
              }
            }
          }
        }
        return { next, changed, recorded };
      });

      gw.bootId = frame.bootId;
      gw.snapshotBootId = frame.bootId;
      gw.snapshotSeq = frame.seq;
      gw.agentVersion = g.agentVersion;
      gw.matterServerVersion = g.matterServerVersion ?? null;
      gw.lastErrorCode = g.lastErrorCode ?? null;
      gw.keyVersion = frame.keyVersion;
      gw.lastSeenAt = t;
      for (const id of removed) this.forget(gw, id);
      for (const d of out.next) this.remember(gw, d);
      if (out.recorded) this.opts.outbox?.kick();

      const source = restarted ? 'resync' : 'gateway';
      const changed = out.changed.map((d) => this.pub(d)).filter((p): p is PublicDevice => !!p);
      for (const p of changed) this.emitDevice(p, source);
      for (const id of removed) this.emit({ type: 'device_removed', siteId: gw.siteId, gatewayId, deviceId: id });
      this.emit({ type: 'gateway', siteId: gw.siteId, gateway: this.view(gw) });
      return { changed, recorded: out.recorded, stale: false };
    });
  }

  applyEvt(gatewayId: string, frame: EvtFrame): Promise<ApplyResult> {
    return this.serial(gatewayId, async () => {
      const gw = await this.ensureGw(gatewayId);
      if (!gw) {
        this.opts.log?.warn({ gatewayId }, 'evt from unknown gateway ignored');
        return EMPTY;
      }
      // snapshot 이 더 새롭다(같은 bootId 의 seq ≤ snapshot.seq), 또는 이 연결의 snapshot 이 아직 없다
      const stale = gw.snapshotBootId !== frame.bootId || frame.seq <= gw.snapshotSeq;
      const siteEpoch = await this.epochFor(gw.siteId, frame.keyVersion);
      const t = this.now();
      const at = isoOr(frame.at, t);
      const replayed = frame.replayed === true;
      const order = gw.siteId && siteEpoch !== null ? { gatewayId, siteId: gw.siteId, siteEpoch, bootId: frame.bootId, seq: frame.seq } : null;

      const out = await this.db.transaction(async (tx) => {
        const ins = await tx
          .insert(events)
          .values({
            eventId: newId('evt'),
            gatewayId,
            bootId: frame.bootId,
            seq: frame.seq,
            sub: 0,
            siteId: gw.siteId,
            siteEpoch,
            keyVersion: frame.keyVersion,
            kind: frame.kind,
            at,
            replayed,
            data: frame.data,
          })
          .onConflictDoNothing()
          .returning({ eventId: events.eventId });
        if (!ins.length) return null; // 중복 (gatewayId, bootId, seq, 0)
        const eventId = ins[0]!.eventId;
        let next: DevState[] = [];
        let removedIds: string[] = [];
        const hooks: WebhookEvent[] = [];
        const base = { createdAt: t.toISOString(), replayed };

        if (frame.kind === 'device' || (frame.kind === 'pairing' && frame.data.devices?.length)) {
          const list = frame.kind === 'device' ? frame.data.devices : frame.data.devices!;
          const plan = list.map((sd) => {
            const id = gw.devices.get(sd.id);
            return { sd, prev: id ? this.devs.get(id) : undefined };
          });
          if (!stale) next = await this.upsertDevices(tx, gw, plan, t);
          if (frame.kind === 'device' && order) {
            plan.forEach((p, i) => {
              const st = next[i] ?? (p.prev ? this.stateFrom(p.sd, p.prev.deviceId, gatewayId, p.prev) : undefined);
              if (!st) return;
              hooks.push({
                eventId: i === 0 ? eventId : newId('evt'),
                type: 'device.state_changed',
                ...base,
                ...order,
                data: { device: this.pubOf(st, order.siteId, true), source: 'event', at: at.toISOString() },
              });
            });
          }
        } else if (frame.kind === 'device_removed') {
          removedIds = frame.data.ids.map((l) => gw.devices.get(l)).filter((x): x is string => !!x);
          if (!stale && removedIds.length) await tx.update(devices).set({ removedAt: t }).where(inArray(devices.deviceId, removedIds));
          if (order) removedIds.forEach((id, i) => hooks.push({ eventId: i === 0 ? eventId : newId('evt'), type: 'device.removed', ...base, ...order, data: { deviceId: id } }));
        } else if (frame.kind === 'error' && !stale) {
          const code = (frame.data as { code?: unknown }).code;
          if (typeof code === 'string') await tx.update(gateways).set({ lastErrorCode: code }).where(eq(gateways.gatewayId, gatewayId));
        }
        for (const h of hooks) await this.opts.outbox?.enqueue(gw.orgId, h, tx);
        return { next, removedIds, hooks: hooks.length };
      });

      if (!out) return { changed: [], recorded: 0, stale };
      if (out.hooks) this.opts.outbox?.kick();
      if (!stale) {
        if (frame.kind === 'error') {
          const code = (frame.data as { code?: unknown }).code;
          if (typeof code === 'string') gw.lastErrorCode = code;
        }
        for (const id of out.removedIds) this.forget(gw, id);
        for (const d of out.next) this.remember(gw, d);
      }
      const changed = out.next.map((d) => this.pub(d)).filter((p): p is PublicDevice => !!p);
      for (const p of changed) this.emitDevice(p, 'event');
      if (!stale) for (const id of out.removedIds) this.emit({ type: 'device_removed', siteId: gw.siteId, gatewayId, deviceId: id });
      if (frame.kind === 'pairing') {
        const deviceIds = (frame.data.devices ?? []).map((sd) => gw.devices.get(sd.id)).filter((x): x is string => !!x);
        this.emit({ type: 'pairing', siteId: gw.siteId, gatewayId, frame, deviceIds });
      }
      return { changed, recorded: 1, stale };
    });
  }

  setGatewayOnline(gatewayId: string, online: boolean, at?: Date): Promise<void> {
    return this.serial(gatewayId, async () => {
      const gw = await this.ensureGw(gatewayId);
      if (!gw) return;
      const t = at ?? this.now();
      gw.lastSeenAt = t;
      if (gw.online === online) return;
      gw.online = online;
      if (!online) gw.snapshotBootId = null; // 다음 연결은 새 snapshot 부터
      await this.db.update(gateways).set({ online, lastSeenAt: t }).where(eq(gateways.gatewayId, gatewayId));
      this.opts.onOnlineCount?.([...this.gws.values()].filter((g) => g.online).length);
      for (const id of gw.devices.values()) {
        const d = this.devs.get(id);
        const p = d && this.pub(d);
        if (p) this.emitDevice(p, 'gateway');
      }
      this.emit({ type: 'gateway', siteId: gw.siteId, gateway: this.view(gw) });
    });
  }

  reloadGateway(gatewayId: string): Promise<void> {
    return this.serial(gatewayId, async () => {
      const [row] = await this.db.select().from(gateways).where(eq(gateways.gatewayId, gatewayId)).limit(1);
      if (!row) return;
      const before = this.gws.get(gatewayId)?.siteId ?? null;
      const gw = this.syncGw(row);
      if (before !== gw.siteId) await this.db.update(devices).set({ siteId: gw.siteId }).where(eq(devices.gatewayId, gatewayId));
      this.emit({ type: 'gateway', siteId: gw.siteId, gateway: this.view(gw) });
    });
  }

  async updateDeviceMeta(deviceId: string, patch: { name?: string; room?: string | null }): Promise<PublicDevice | undefined> {
    const d = this.devs.get(deviceId);
    if (!d) return undefined;
    const set: { name?: string; room?: string | null } = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.room !== undefined) set.room = patch.room;
    if (Object.keys(set).length) await this.db.update(devices).set(set).where(eq(devices.deviceId, deviceId));
    Object.assign(d, set);
    const p = this.pub(d);
    if (p) this.emitDevice(p, 'gateway');
    return p;
  }

  // ---------------- 내부 ----------------

  private serial<T>(gatewayId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(gatewayId) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(gatewayId, tail);
    void tail.then(() => {
      if (this.locks.get(gatewayId) === tail) this.locks.delete(gatewayId);
    });
    return p;
  }

  private syncGw(r: typeof gateways.$inferSelect): GwState {
    const prev = this.gws.get(r.gatewayId);
    const gw: GwState = {
      gatewayId: r.gatewayId,
      shortId: r.shortId,
      orgId: r.orgId,
      siteId: r.siteId,
      status: r.status,
      online: prev?.online ?? false,
      lastSeenAt: prev?.lastSeenAt ?? r.lastSeenAt,
      agentVersion: prev?.agentVersion ?? r.agentVersion,
      matterServerVersion: prev?.matterServerVersion ?? r.matterServerVersion,
      lastErrorCode: prev ? prev.lastErrorCode : r.lastErrorCode,
      claimWindowUntil: r.claimWindowUntil,
      bootId: prev?.bootId ?? r.bootId,
      keyVersion: prev?.keyVersion ?? r.keyVersion,
      snapshotBootId: prev?.snapshotBootId ?? null,
      snapshotSeq: prev?.snapshotSeq ?? 0,
      devices: prev?.devices ?? new Map(),
    };
    this.gws.set(r.gatewayId, gw);
    return gw;
  }

  private async ensureGw(gatewayId: string): Promise<GwState | undefined> {
    const gw = this.gws.get(gatewayId);
    if (gw) return gw;
    // 이 프로세스 기동 뒤 운영자 CLI 로 출고 등록된 GW
    const [row] = await this.db.select().from(gateways).where(eq(gateways.gatewayId, gatewayId)).limit(1);
    return row ? this.syncGw(row) : undefined;
  }

  private async epochFor(siteId: string | null, keyVersion: number): Promise<number | null> {
    if (!siteId) return null;
    const k = `${siteId}:${keyVersion}`;
    const hit = this.epochs.get(k);
    if (hit !== undefined) return hit;
    const [r] = await this.db
      .select({ epoch: siteKeys.epoch })
      .from(siteKeys)
      .where(sql`${siteKeys.siteId} = ${siteId} and ${siteKeys.version} = ${keyVersion}`)
      .limit(1);
    if (r) {
      this.epochs.set(k, r.epoch); // (siteId, version) → epoch 는 바뀌지 않는다
      return r.epoch;
    }
    if (keyVersion === 0) {
      // 첫 cfg 적용 전(키 미설정) → 현재 거주 기간
      const [s] = await this.db.select({ epoch: sites.epoch }).from(sites).where(eq(sites.siteId, siteId)).limit(1);
      return s?.epoch ?? null;
    }
    return null;
  }

  private stateFrom(sd: SiotDevice, deviceId: string, gatewayId: string, prev?: { name: string; room: string | null }): DevState {
    return {
      deviceId,
      gatewayId,
      localId: sd.id,
      name: prev?.name ?? sd.name,
      room: prev?.room ?? null,
      deviceType: sd.deviceType,
      data: toData(sd.data),
      online: Boolean(sd.online),
      vendor: sd.vendor ?? null,
      model: sd.model ?? null,
      lastUpdated: sd.lastUpdated,
    };
  }

  /** devices upsert. 이름·위치는 최초 등록 때만 GW 값을 쓰고 이후 클라우드 값을 유지한다 */
  private async upsertDevices(tx: Tx, gw: GwState, plan: { sd: SiotDevice; prev?: DevState }[], t: Date): Promise<DevState[]> {
    if (!plan.length) return [];
    const rows = plan.map(({ sd, prev }) => ({
      deviceId: prev?.deviceId ?? newId('dev'),
      gatewayId: gw.gatewayId,
      localId: sd.id,
      siteId: gw.siteId,
      name: prev?.name ?? sd.name,
      room: prev?.room ?? null,
      deviceType: sd.deviceType,
      data: toData(sd.data),
      online: Boolean(sd.online),
      vendor: sd.vendor ?? null,
      model: sd.model ?? null,
      lastUpdated: isoOr(sd.lastUpdated, t),
      removedAt: null,
    }));
    const ret = await tx
      .insert(devices)
      .values(rows)
      .onConflictDoUpdate({
        target: [devices.gatewayId, devices.localId],
        set: {
          siteId: sql`excluded.site_id`,
          deviceType: sql`excluded.device_type`,
          data: sql`excluded.data`,
          online: sql`excluded.online`,
          vendor: sql`excluded.vendor`,
          model: sql`excluded.model`,
          lastUpdated: sql`excluded.last_updated`,
          removedAt: sql`null`,
        },
      })
      .returning({ deviceId: devices.deviceId, localId: devices.localId, name: devices.name, room: devices.room });
    const byLocal = new Map(ret.map((r) => [r.localId, r]));
    return plan.map(({ sd }) => {
      const r = byLocal.get(sd.id)!;
      return this.stateFrom(sd, r.deviceId, gw.gatewayId, { name: r.name, room: r.room });
    });
  }

  private remember(gw: GwState, d: DevState): void {
    this.devs.set(d.deviceId, d);
    gw.devices.set(d.localId, d.deviceId);
  }

  private forget(gw: GwState, deviceId: string): void {
    const d = this.devs.get(deviceId);
    if (d) gw.devices.delete(d.localId);
    this.devs.delete(deviceId);
  }

  private pubOf(d: DevState, siteId: string, gwOnline: boolean): PublicDevice {
    return {
      deviceId: d.deviceId,
      gatewayId: d.gatewayId,
      siteId,
      name: d.name,
      room: d.room,
      deviceType: d.deviceType,
      online: d.online && gwOnline,
      data: { ...d.data },
      lastUpdated: d.lastUpdated,
      vendor: d.vendor,
      model: d.model,
    };
  }

  private pub(d: DevState): PublicDevice | undefined {
    const gw = this.gws.get(d.gatewayId);
    if (!gw?.siteId) return undefined;
    return this.pubOf(d, gw.siteId, gw.online);
  }

  private view(g: GwState): GatewayView {
    return {
      gatewayId: g.gatewayId,
      shortId: g.shortId,
      orgId: g.orgId,
      siteId: g.siteId,
      status: g.status,
      online: g.online,
      lastSeenAt: g.lastSeenAt,
      agentVersion: g.agentVersion,
      matterServerVersion: g.matterServerVersion,
      lastErrorCode: g.lastErrorCode,
      deviceCount: g.devices.size,
      claimWindowUntil: g.claimWindowUntil,
      bootId: g.bootId,
      keyVersion: g.keyVersion,
    };
  }

  private emitDevice(p: PublicDevice, source: 'event' | 'resync' | 'gateway'): void {
    for (const l of this.deviceListeners) {
      try {
        l(p, source);
      } catch (err) {
        this.opts.log?.error({ err }, 'device listener failed');
      }
    }
    this.emit({ type: 'device', siteId: p.siteId, device: p, source });
  }

  private emit(ev: CacheEvent): void {
    for (const l of this.eventListeners) {
      try {
        l(ev);
      } catch (err) {
        this.opts.log?.error({ err }, 'cache event listener failed');
      }
    }
  }
}
