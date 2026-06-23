// 기기 카드 (표시 전용). 켜고/끄기는 onToggle 콜백으로 위임. (단계 4)
import type { SiotDevice } from "@/lib/types";

// 켜기/끄기 토글을 노출할 기기 종류.
const CONTROLLABLE = new Set(["PLUG", "SWITCH", "LIGHT", "FAN"]);

const TYPE_LABEL: Record<string, string> = {
  PLUG: "플러그",
  SWITCH: "스위치",
  LIGHT: "조명",
  FAN: "팬",
  SENSOR: "센서",
  BINARY_SENSOR: "감지기",
  COVER: "커버",
  CLIMATE: "냉난방",
  LOCK: "잠금",
  WEATHER: "날씨",
  UNKNOWN: "기타",
};

/** 제어 불가 기기의 상태를 한 줄 요약. */
function summarize(device: SiotDevice): string {
  const d = device.data;
  switch (device.deviceType) {
    case "SENSOR":
      return `${d.value ?? "-"}${d.unit ? ` ${d.unit}` : ""}`;
    case "BINARY_SENSOR":
      return d.active ? "감지됨" : "정상";
    case "WEATHER":
      return [
        d.condition,
        d.temperature != null ? `${d.temperature}°C` : null,
        d.humidity != null ? `습도 ${d.humidity}%` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "COVER":
      return d.open ? "열림" : "닫힘";
    case "LOCK":
      return d.locked ? "잠김" : "열림";
    case "CLIMATE":
      return `${d.mode ?? "-"}${d.temperature != null ? ` · ${d.temperature}°C` : ""}`;
    default:
      return String(d.state ?? d.value ?? "-");
  }
}

export function DeviceCard({
  device,
  busy,
  onToggle,
}: {
  device: SiotDevice;
  busy: boolean;
  onToggle: (device: SiotDevice) => void;
}) {
  const controllable = CONTROLLABLE.has(device.deviceType);
  const on = device.data.switch === true;

  return (
    <div
      className={`flex flex-col justify-between rounded-2xl border p-5 shadow-sm transition
        ${device.online ? "border-black/10 bg-white dark:border-white/10 dark:bg-white/5" : "border-black/5 bg-black/[0.02] opacity-60 dark:border-white/5 dark:bg-white/[0.02]"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{device.name}</p>
          <p className="mt-0.5 text-xs text-black/50 dark:text-white/40">
            {TYPE_LABEL[device.deviceType] ?? device.deviceType}
          </p>
        </div>
        <span
          className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
            device.online ? "bg-emerald-500" : "bg-black/20 dark:bg-white/20"
          }`}
          title={device.online ? "온라인" : "오프라인"}
        />
      </div>

      <div className="mt-5">
        {controllable ? (
          <button
            type="button"
            disabled={busy || !device.online}
            onClick={() => onToggle(device)}
            className={`w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50
              ${
                on
                  ? "bg-emerald-500 text-white hover:bg-emerald-600"
                  : "bg-black/5 text-black/70 hover:bg-black/10 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/20"
              }`}
          >
            {busy ? "..." : on ? "켜짐 — 끄기" : "꺼짐 — 켜기"}
          </button>
        ) : (
          <p className="text-2xl font-semibold tabular-nums">
            {summarize(device)}
          </p>
        )}
      </div>
    </div>
  );
}
