"use client";

// 기기 목록 로딩 + 제어 처리 (클라이언트). (단계 4)
import { useCallback, useEffect, useState } from "react";
import type { SiotDevice } from "@/lib/types";
import { DeviceCard } from "./device-card";

interface DevicesResponse {
  ok: boolean;
  count?: number;
  devices?: SiotDevice[];
  error?: string;
}

export function DeviceGrid() {
  const [devices, setDevices] = useState<SiotDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // 첫 await(fetch) 전에 동기 setState를 하지 않는다 (effect 내 호출 안전).
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      const json: DevicesResponse = await res.json();
      if (!json.ok) throw new Error(json.error ?? "기기 목록을 불러오지 못했습니다.");
      setDevices(json.devices ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 마운트 시 전체 목록 1회 로드. 이후 갱신은 SSE(아래)로 받는다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    // 단계 6: HA state_changed를 SSE로 실시간 수신 → 해당 카드만 갱신.
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      let device: SiotDevice;
      try {
        device = JSON.parse(ev.data);
      } catch {
        return;
      }
      setDevices((prev) => {
        const i = prev.findIndex((d) => d.id === device.id);
        if (i === -1) return [...prev, device]; // 새로 페어링된 기기 즉시 표시.
        const next = prev.slice();
        next[i] = device;
        return next;
      });
    };
    // 연결 끊김은 EventSource가 자동 재연결하므로 별도 처리 불필요.
    return () => es.close();
  }, []);

  const toggle = useCallback(
    async (device: SiotDevice) => {
      setBusyId(device.id);
      // 낙관적 업데이트.
      setDevices((prev) =>
        prev.map((d) =>
          d.id === device.id
            ? { ...d, data: { ...d.data, switch: !(d.data.switch === true) } }
            : d,
        ),
      );
      try {
        const res = await fetch(`/api/devices/${device.id}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "TOGGLE" }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? "제어 실패");
        // 서버가 돌려준 권위 상태로 교체.
        setDevices((prev) =>
          prev.map((d) => (d.id === device.id ? json.device : d)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        load(); // 실패 시 실제 상태로 되돌림.
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (loading) {
    return <p className="text-black/50 dark:text-white/40">기기를 불러오는 중…</p>;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
        <p className="font-semibold">HA 연결 오류</p>
        <p className="mt-1">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-3 rounded-lg bg-red-500/10 px-3 py-1.5 font-medium hover:bg-red-500/20"
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <p className="text-black/50 dark:text-white/40">
        연결된 기기가 없습니다. HA에 기기를 페어링하면 여기 표시됩니다.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {devices.map((d) => (
        <DeviceCard
          key={d.id}
          device={d}
          busy={busyId === d.id}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}
