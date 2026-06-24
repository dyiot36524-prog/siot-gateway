"use client";

// 페어링 플로우 컴포넌트. 프로토콜 선택 → API 호출 → 결과 표시.
import { useState } from "react";
import Link from "next/link";
import type { SiotDevice } from "@/lib/types";

// 지원 프로토콜 목록.
type Protocol = "MATTER" | "ZIGBEE" | "DEMO";

interface ProtocolOption {
  protocol: Protocol;
  label: string;
  description: string;
}

const PROTOCOLS: ProtocolOption[] = [
  {
    protocol: "MATTER",
    label: "Matter",
    description: "Matter 표준 기기. 허브(안테나) 연결 필요.",
  },
  {
    protocol: "ZIGBEE",
    label: "Zigbee",
    description: "Zigbee 기기. Zigbee 코디네이터(안테나) 연결 필요.",
  },
  {
    protocol: "DEMO",
    label: "데모(가상 기기)",
    description: "추가 하드웨어 없이 즉시 가상 기기를 추가합니다.",
  },
];

// 상태 머신 단계.
type Step =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "paired"; device: SiotDevice }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; error: string };

// API 응답 타입.
interface PairingResponse {
  ok: boolean;
  status?: "paired" | "unsupported";
  device?: SiotDevice;
  message?: string;
  error?: string;
}

export function PairingFlow() {
  const [selected, setSelected] = useState<Protocol | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });

  // 페어링 시작 버튼 클릭.
  async function handleStart() {
    if (!selected) return;
    setStep({ kind: "loading" });

    try {
      const res = await fetch("/api/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: selected }),
      });

      const json: PairingResponse = await res.json();

      if (!res.ok || json.ok === false) {
        setStep({ kind: "error", error: json.error ?? "알 수 없는 오류가 발생했습니다." });
        return;
      }

      if (json.status === "paired" && json.device) {
        setStep({ kind: "paired", device: json.device });
      } else if (json.status === "unsupported") {
        setStep({ kind: "unsupported", message: json.message ?? "지원되지 않는 프로토콜입니다." });
      } else {
        setStep({ kind: "error", error: "서버 응답 형식이 올바르지 않습니다." });
      }
    } catch {
      setStep({ kind: "error", error: "네트워크 오류가 발생했습니다. 다시 시도해 주세요." });
    }
  }

  // idle로 초기화.
  function handleReset() {
    setStep({ kind: "idle" });
    setSelected(null);
  }

  // ── 로딩 화면 ──────────────────────────────────────────────────
  if (step.kind === "loading") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        {/* 스피너 */}
        <div
          className="h-10 w-10 rounded-full border-4 border-black/10 border-t-siot-500 dark:border-white/10 dark:border-t-siot-400 animate-spin"
          aria-hidden="true"
        />
        <p className="text-base font-medium text-black/60 dark:text-white/50">
          기기를 찾는 중…
        </p>
      </div>
    );
  }

  // ── 페어링 완료 화면 ───────────────────────────────────────────
  if (step.kind === "paired") {
    return (
      <div className="rounded-2xl border border-siot-500/30 bg-siot-500/5 p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-siot-500 text-white">
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m5 13 4 4L19 7" />
            </svg>
          </span>
          <div>
            <p className="text-lg font-bold text-siot-600 dark:text-siot-400">
              페어링 완료
            </p>
            <p className="text-sm text-black/60 dark:text-white/50 mt-0.5">
              {step.device.name}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="flex min-h-12 w-full items-center justify-center rounded-2xl bg-siot-500 px-5 py-3 text-base font-semibold text-white hover:bg-siot-600 transition sm:w-auto sm:flex-1"
          >
            홈에서 확인
          </Link>
          <button
            type="button"
            onClick={handleReset}
            className="flex min-h-12 w-full items-center justify-center rounded-2xl border border-black/10 bg-white px-5 py-3 text-base font-semibold text-black/70 hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10 transition sm:w-auto sm:flex-1"
          >
            다른 기기 추가
          </button>
        </div>
      </div>
    );
  }

  // ── 미지원 안내 화면 ───────────────────────────────────────────
  if (step.kind === "unsupported") {
    return (
      <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/5 p-6 flex flex-col gap-4">
        <div>
          <p className="text-base font-bold text-yellow-700 dark:text-yellow-400">
            하드웨어 안테나 필요
          </p>
          <p className="mt-1 text-sm text-black/60 dark:text-white/50">
            {step.message}
          </p>
          <p className="mt-2 text-sm text-black/50 dark:text-white/40">
            Matter · Zigbee 기기를 추가하려면 호환 허브 또는 코디네이터 하드웨어가 연결되어 있어야 합니다.
            지금 바로 시험해 보려면 &ldquo;데모(가상 기기)&rdquo;를 선택하세요.
          </p>
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="flex min-h-12 w-full items-center justify-center rounded-2xl border border-black/10 bg-white px-5 py-3 text-base font-semibold text-black/70 hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10 transition"
        >
          다시
        </button>
      </div>
    );
  }

  // ── 에러 화면 ─────────────────────────────────────────────────
  if (step.kind === "error") {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 flex flex-col gap-4">
        <div>
          <p className="text-base font-bold text-red-600 dark:text-red-400">
            오류 발생
          </p>
          <p className="mt-1 text-sm text-black/60 dark:text-white/50">
            {step.error}
          </p>
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="flex min-h-12 w-full items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-3 text-base font-semibold text-red-600 hover:bg-red-500/20 dark:text-red-400 transition"
        >
          다시
        </button>
      </div>
    );
  }

  // ── idle: 프로토콜 선택 + 시작 버튼 ──────────────────────────
  return (
    <div className="flex flex-col gap-5">
      {/* 프로토콜 선택 카드 — 기본 세로 스택, sm: 가로 3열 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {PROTOCOLS.map((opt) => {
          const isSelected = selected === opt.protocol;
          return (
            <button
              key={opt.protocol}
              type="button"
              onClick={() => setSelected(opt.protocol)}
              className={`flex min-h-24 w-full flex-col items-start gap-2 rounded-2xl border p-5 text-left transition
                ${
                  isSelected
                    ? "border-siot-500 bg-siot-500/10 dark:border-siot-400 dark:bg-siot-400/10"
                    : "border-black/10 bg-white hover:border-black/20 hover:bg-black/[0.02] dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20 dark:hover:bg-white/10"
                }`}
            >
              <span
                className={`text-base font-bold ${
                  isSelected ? "text-siot-600 dark:text-siot-400" : ""
                }`}
              >
                {opt.label}
              </span>
              <span className="text-sm text-black/50 dark:text-white/40">
                {opt.description}
              </span>
              {/* 선택 표시 */}
              {isSelected && (
                <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-siot-600 dark:text-siot-400">
                  <span aria-hidden="true">●</span> 선택됨
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 페어링 시작 버튼 */}
      <button
        type="button"
        disabled={!selected}
        onClick={handleStart}
        className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-siot-500 px-5 py-4 text-base font-bold text-white transition hover:bg-siot-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        페어링 시작
      </button>
    </div>
  );
}
