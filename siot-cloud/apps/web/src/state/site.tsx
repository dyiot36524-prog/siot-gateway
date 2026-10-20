// 세대 실시간 상태: 목록 + SSE + GW 별 페어링 큐. 세대 하위 화면(상세·GW 추가·페어링·체커)이 공유한다.
// SSE 가 (재)연결되거나 화면이 다시 보이면 목록을 다시 읽는다(app-v1: Last-Event-ID 미지원).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  isGateway,
  type Device,
  type Gateway,
  type GatewayDiagnostics,
  type PairingSession,
  type Site,
  type SiteEvent,
  type StreamStatus,
} from '../api/client';
import { apiErrorText } from '../lib/messages';
import { store } from '../lib/store';
import { useSession } from './session';

export interface PairingEntry {
  localId: string;
  gatewayId: string;
  code: string;
  name: string;
  room: string | null;
  sessionId: string | null;
  attempts: number;
  /** 이름·위치를 기기에 반영했는지 */
  applied: boolean;
  enqueueError: string | null;
  createdAt: number;
}

export const isTerminal = (s: PairingSession | undefined) => !!s && (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled');

interface SiteLive {
  siteId: string;
  site: Site | null;
  gateways: Array<Gateway | GatewayDiagnostics>;
  devices: Device[];
  /** 인계 후 기사: 기기 목록 403(진단만) */
  devicesHidden: boolean;
  loading: boolean;
  loadError: string | null;
  stream: StreamStatus;
  reload(): Promise<void>;
  entries: PairingEntry[];
  sessions: Record<string, PairingSession>;
  enqueue(gatewayId: string, code: string, meta?: { name?: string; room?: string | null }): Promise<PairingEntry>;
  retry(localId: string): Promise<void>;
  dismiss(localId: string): void;
  setEntryMeta(localId: string, meta: { name?: string; room?: string | null }): Promise<void>;
  saveDevice(deviceId: string, patch: { name?: string; room?: string | null }): Promise<void>;
}

const Ctx = createContext<SiteLive | null>(null);

export function useSite(): SiteLive {
  const v = useContext(Ctx);
  if (!v) throw new Error('SiteLiveProvider missing');
  return v;
}

const POLL_MS = 4000;
const entriesKey = (siteId: string) => `siot.pairing.${siteId}`;
let seq = 0;
const newLocalId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export function SiteLiveProvider({ siteId, children }: { siteId: string; children: ReactNode }) {
  const { api, setOffline } = useSession();
  const [site, setSite] = useState<Site | null>(null);
  const [gateways, setGateways] = useState<Array<Gateway | GatewayDiagnostics>>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesHidden, setDevicesHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamStatus>('connecting');
  const [entries, setEntries] = useState<PairingEntry[]>(() => store.getJson<PairingEntry[]>(entriesKey(siteId)) ?? []);
  const [sessions, setSessions] = useState<Record<string, PairingSession>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => store.setJson(entriesKey(siteId), entries), [siteId, entries]);

  const putSession = useCallback((s: PairingSession) => {
    setSessions((prev) => {
      const old = prev[s.pairingSessionId];
      if (old && old.updatedAt > s.updatedAt) return prev;
      return { ...prev, [s.pairingSessionId]: s };
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    const ids = entriesRef.current.map((e) => e.sessionId).filter((id): id is string => !!id && !isTerminal(sessionsRef.current[id]));
    await Promise.all(
      ids.map((id) =>
        api.getPairing(id).then(putSession, (e: unknown) => {
          // 서버에 없는 세션(만료·초기화)은 재시도할 수 있게 풀어 준다. 그 밖의 오류는 다음 폴링에서 다시
          if (e instanceof ApiError && e.status === 404) {
            setEntries((prev) =>
              prev.map((x) => (x.sessionId === id ? { ...x, sessionId: null, enqueueError: '페어링 기록을 찾을 수 없습니다. 다시 시도하세요.' } : x)),
            );
          }
        }),
      ),
    );
  }, [api, putSession]);

  const reload = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([api.getSite(siteId), api.listSiteGateways(siteId)]);
      setSite(s);
      setGateways(g.data);
      try {
        setDevices((await api.listSiteDevices(siteId)).data);
        setDevicesHidden(false);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e;
        setDevices([]); // 인계 후 기사: 진단만
        setDevicesHidden(true);
      }
      setLoadError(null);
      setOffline(false);
      void refreshSessions();
    } catch (e) {
      if (!(e instanceof ApiError)) setOffline(true);
      setLoadError(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [api, siteId, setOffline, refreshSessions]);

  // SSE
  useEffect(() => {
    const onEvent = (e: SiteEvent) => {
      switch (e.event) {
        case 'device':
          setDevices((prev) => {
            const i = prev.findIndex((d) => d.deviceId === e.data.deviceId);
            if (i < 0) return [...prev, e.data];
            const next = prev.slice();
            next[i] = { ...prev[i]!, ...e.data };
            return next;
          });
          break;
        case 'device_removed':
          setDevices((prev) => prev.filter((d) => d.deviceId !== e.data.deviceId));
          break;
        case 'gateway': {
          const g = e.data;
          if (!isGateway(g)) {
            void reload();
            break;
          }
          setGateways((prev) => {
            const i = prev.findIndex((x) => isGateway(x) && x.gatewayId === g.gatewayId);
            if (i < 0) return g.siteId === siteId ? [...prev, g] : prev;
            const next = prev.slice();
            next[i] = { ...prev[i]!, ...g };
            return next;
          });
          // GW 가 오프라인이면 그 GW 의 기기도 오프라인으로 보인다(Device.online = 기기 && GW)
          if (!g.online) setDevices((prev) => prev.map((d) => (d.gatewayId === g.gatewayId ? { ...d, online: false } : d)));
          break;
        }
        case 'pairing':
          putSession(e.data);
          break;
      }
    };
    let wasOpen = false;
    const close = api.streamSiteEvents(siteId, onEvent, (s) => {
      setStream(s);
      if (s === 'open') {
        setOffline(false);
        if (wasOpen) void reload(); // 재연결: 놓친 이벤트를 목록으로 메운다
        wasOpen = true;
      }
    });
    return close;
  }, [api, siteId, putSession, reload, setOffline]);

  useEffect(() => {
    void reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  // SSE 가 끊긴 동안은 진행 중 페어링을 폴링
  const pending = entries.some((e) => e.sessionId && !isTerminal(sessions[e.sessionId]));
  useEffect(() => {
    if (!pending || stream === 'open') return;
    const t = setInterval(() => void refreshSessions(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, stream, refreshSessions]);

  // 완료된 페어링에 대기 중 입력한 이름·위치 반영 + 기기 목록 갱신
  useEffect(() => {
    for (const en of entries) {
      const s = en.sessionId ? sessions[en.sessionId] : undefined;
      if (!s || s.status !== 'done' || en.applied) continue;
      setEntries((prev) => prev.map((x) => (x.localId === en.localId ? { ...x, applied: true } : x)));
      const patch: { name?: string; room?: string | null } = {};
      if (en.name.trim()) patch.name = en.name.trim();
      if (en.room) patch.room = en.room;
      void (async () => {
        if (Object.keys(patch).length) {
          await Promise.all(
            s.deviceIds.map((id, i) =>
              api
                .updateDevice(id, { ...patch, ...(patch.name && s.deviceIds.length > 1 ? { name: `${patch.name} ${i + 1}` } : {}) })
                .catch(() => undefined),
            ),
          );
        }
        try {
          setDevices((await api.listSiteDevices(siteId)).data);
        } catch {
          /* SSE device 이벤트로 채워진다 */
        }
      })();
    }
  }, [entries, sessions, api, siteId]);

  const submit = useCallback(
    async (entry: PairingEntry) => {
    try {
      const body: { code: string; name?: string } = { code: entry.code };
      if (entry.name.trim()) body.name = entry.name.trim();
      const r = await api.enqueuePairing(entry.gatewayId, body);
      const now = new Date().toISOString();
      putSession({
        pairingSessionId: r.pairingSessionId,
        gatewayId: entry.gatewayId,
        status: 'queued',
        stage: 'queued',
        errorCode: null,
        error: null,
        deviceIds: [],
        queuePosition: r.queuePosition,
        createdAt: now,
        updatedAt: '',
      });
      setEntries((prev) => prev.map((x) => (x.localId === entry.localId ? { ...x, sessionId: r.pairingSessionId, enqueueError: null } : x)));
      api.getPairing(r.pairingSessionId).then(putSession, () => undefined);
    } catch (e) {
      setEntries((prev) => prev.map((x) => (x.localId === entry.localId ? { ...x, enqueueError: apiErrorText(e) } : x)));
    }
     },
    [api, putSession],
  );

  const enqueue = useCallback<SiteLive['enqueue']>(
    async (gatewayId, code, meta = {}) => {
      const entry: PairingEntry = {
        localId: newLocalId(),
        gatewayId,
        code,
        name: meta.name ?? '',
        room: meta.room ?? null,
        sessionId: null,
        attempts: 1,
        applied: false,
        enqueueError: null,
        createdAt: Date.now(),
      };
      setEntries((prev) => [...prev, entry]);
      await submit(entry);
      return entry;
    },
    [submit],
  );

  const retry = useCallback(
    async (localId: string) => {
      const en = entriesRef.current.find((x) => x.localId === localId);
      if (!en) return;
      const next: PairingEntry = { ...en, sessionId: null, attempts: en.attempts + 1, applied: false, enqueueError: null };
      setEntries((prev) => prev.map((x) => (x.localId === localId ? next : x)));
      await submit(next);
    },
    [submit],
  );

  const dismiss = useCallback((localId: string) => setEntries((prev) => prev.filter((x) => x.localId !== localId)), []);

  const saveDevice = useCallback(
    async (deviceId: string, patch: { name?: string; room?: string | null }) => {
      const d = await api.updateDevice(deviceId, patch);
      setDevices((prev) => prev.map((x) => (x.deviceId === deviceId ? { ...x, ...d } : x)));
    },
    [api],
  );

  const setEntryMeta = useCallback(
    async (localId: string, meta: { name?: string; room?: string | null }) => {
      const en = entriesRef.current.find((x) => x.localId === localId);
      if (!en) return;
      const merged = { ...en, ...meta };
      setEntries((prev) => prev.map((x) => (x.localId === localId ? merged : x)));
      const s = en.sessionId ? sessionsRef.current[en.sessionId] : undefined;
      if (s?.status === 'done' && en.applied) {
        // 이미 기기가 생겼으면 바로 저장
        const patch: { name?: string; room?: string | null } = {};
        if (meta.name !== undefined && meta.name.trim()) patch.name = meta.name.trim();
        if (meta.room !== undefined) patch.room = meta.room;
        if (Object.keys(patch).length) await Promise.all(s.deviceIds.map((id) => saveDevice(id, patch)));
      }
    },
    [saveDevice],
  );

  const value = useMemo<SiteLive>(
    () => ({
      siteId,
      site,
      gateways,
      devices,
      devicesHidden,
      loading,
      loadError,
      stream,
      reload,
      entries,
      sessions,
      enqueue,
      retry,
      dismiss,
      setEntryMeta,
      saveDevice,
    }),
    [siteId, site, gateways, devices, devicesHidden, loading, loadError, stream, reload, entries, sessions, enqueue, retry, dismiss, setEntryMeta, saveDevice],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** GW 표시 이름: 목록 순서대로 GW A, GW B … */
export function gatewayLabel(gateways: Array<Gateway | GatewayDiagnostics>, gatewayId: string): string {
  const i = gateways.findIndex((g) => isGateway(g) && g.gatewayId === gatewayId);
  return i < 0 ? 'GW' : `GW ${String.fromCharCode(65 + i)}`;
}
