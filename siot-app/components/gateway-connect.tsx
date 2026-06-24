"use client";

// 게이트웨이 연결 코드 생성 및 게이트웨이 정보 표시 컴포넌트
import { useState, useEffect } from "react";
// QR 코드 SVG 렌더링 라이브러리 (qrcode.react v4)
import { QRCodeSVG } from "qrcode.react";

// GET /api/gateway 응답 형태
interface GatewayInfo {
  ok: boolean;
  gatewayId: string;
  registered: boolean;
  hasCode: boolean;
}

// POST /api/register 응답 형태
interface RegisterResponse {
  ok: boolean;
  gatewayId?: string;
  registrationCode?: string;
  expiresAt?: string; // ISO 8601
  note?: string;
  error?: string;
}

// 컴포넌트 내부 상태
type Status = "idle" | "loading" | "success" | "error";

// 만료 시각을 사람이 읽기 좋은 형태로 포매팅
function formatExpiry(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function GatewayConnect() {
  // 게이트웨이 정보 상태
  const [gatewayInfo, setGatewayInfo] = useState<GatewayInfo | null>(null);
  const [gatewayInfoError, setGatewayInfoError] = useState(false);

  // 코드 생성 상태
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // 게이트웨이 정보 로드
  async function loadGatewayInfo() {
    try {
      const res = await fetch("/api/gateway", { cache: "no-store" });
      const json: GatewayInfo = await res.json();
      if (json.ok) {
        setGatewayInfo(json);
        setGatewayInfoError(false);
      } else {
        setGatewayInfoError(true);
      }
    } catch {
      setGatewayInfoError(true);
    }
  }

  // 마운트 시 게이트웨이 정보 fetch (loadGatewayInfo는 첫 await 전 동기 setState 없음).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadGatewayInfo();
  }, []);

  // 연결 코드 생성 요청
  async function handleGenerate() {
    setStatus("loading");
    setData(null);
    setErrorMsg("");
    setCopied(false);

    try {
      const res = await fetch("/api/register", { method: "POST" });
      const json: RegisterResponse = await res.json();

      if (json.ok) {
        setData(json);
        setStatus("success");
        // 코드 생성 성공 후 게이트웨이 정보 갱신
        loadGatewayInfo();
      } else {
        setErrorMsg(json.error ?? "서버에서 오류가 반환되었습니다.");
        setStatus("error");
      }
    } catch {
      setErrorMsg("네트워크 오류가 발생했습니다. 연결을 확인해 주세요.");
      setStatus("error");
    }
  }

  // 클립보드 복사
  async function handleCopy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 복사 실패 시 무시
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 게이트웨이 정보 카드 */}
      {!gatewayInfoError && (
        <div className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
          {gatewayInfo ? (
            <div className="flex flex-col gap-3">
              {/* 게이트웨이 ID */}
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium uppercase tracking-wider text-black/40 dark:text-white/30">
                  게이트웨이 ID
                </p>
                <p className="break-all font-mono text-sm text-black dark:text-white">
                  {gatewayInfo.gatewayId}
                </p>
              </div>

              {/* 이 게이트웨이의 mDNS .local 주소 */}
              {(() => {
                // shortId: "gw_" 뒤 8자 (slice(3,11))
                const shortId = gatewayInfo.gatewayId.slice(3, 11);
                const localUrl = `http://siot-${shortId}.local:3000`;
                return (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium uppercase tracking-wider text-black/40 dark:text-white/30">
                      이 게이트웨이 주소
                    </p>
                    <a
                      href={localUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-mono text-sm text-siot-600 underline underline-offset-2 hover:text-siot-700 dark:text-siot-400 dark:hover:text-siot-300"
                    >
                      {localUrl}
                    </a>
                    <p className="text-xs text-black/40 dark:text-white/30">
                      같은 와이파이의 폰·PC 브라우저에서 이 주소로 IP 없이 접속할 수 있어요. (윈도우는 Bonjour 필요)
                    </p>
                  </div>
                );
              })()}

              {/* QR 코드 — gatewayId가 로드된 경우에만 표시 */}
              <div className="flex flex-col items-center gap-2 pt-1">
                {/* 스캔 가독성을 위해 다크모드에서도 흰 배경 유지 */}
                <div className="bg-white p-3 rounded-xl">
                  <QRCodeSVG
                    value={gatewayInfo.gatewayId}
                    size={160}
                    marginSize={2}
                  />
                </div>
                <p className="text-xs text-center text-black/40 dark:text-white/30">
                  이 QR을 시옷플랫폼 앱으로 스캔해 게이트웨이를 연동하세요.
                </p>
              </div>

              {/* 등록 상태 배지 */}
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    gatewayInfo.registered
                      ? "bg-siot-100 text-siot-700 dark:bg-siot-500/20 dark:text-siot-400"
                      : "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/40"
                  }`}
                >
                  {gatewayInfo.registered ? "등록됨" : "미등록"}
                </span>
                {gatewayInfo.hasCode && (
                  <span className="text-xs text-black/40 dark:text-white/30">
                    대기 중인 코드 있음
                  </span>
                )}
              </div>
            </div>
          ) : (
            /* 로딩 스켈레톤 */
            <div className="flex flex-col gap-3">
              <div className="h-3 w-24 animate-pulse rounded bg-black/10 dark:bg-white/10" />
              <div className="h-4 w-48 animate-pulse rounded bg-black/10 dark:bg-white/10" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-black/10 dark:bg-white/10" />
            </div>
          )}
        </div>
      )}

      {/* 게이트웨이 정보 로드 실패 시 비치명적 안내 */}
      {gatewayInfoError && (
        <p className="text-xs text-black/40 dark:text-white/30">
          게이트웨이 정보를 불러올 수 없습니다.
        </p>
      )}

      {/* 안내 문구 */}
      <p className="text-sm text-black/60 dark:text-white/50">
        아래 버튼으로 연결 코드를 생성한 뒤, 시옷플랫폼 앱에서 이 코드를
        입력하세요.
      </p>

      {/* 성공 상태: 코드 표시 영역 */}
      {status === "success" && data && (
        <div className="flex flex-col gap-4 rounded-2xl border border-black/10 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-white/5">
          {/* 등록 코드 */}
          <div className="flex flex-col items-center gap-3 rounded-xl bg-black/[0.03] px-4 py-6 dark:bg-white/[0.04]">
            <p className="text-xs font-medium uppercase tracking-wider text-black/40 dark:text-white/30">
              등록 코드
            </p>
            <p className="text-3xl font-mono font-bold tracking-widest text-black dark:text-white">
              {data.registrationCode}
            </p>
            {/* 유효 시간 안내 */}
            {data.expiresAt && (
              <p className="text-xs text-black/40 dark:text-white/30">
                10분 내 유효 · {formatExpiry(data.expiresAt)}까지
              </p>
            )}
          </div>

          {/* 복사 버튼 */}
          <button
            type="button"
            onClick={() => handleCopy(data.registrationCode ?? "")}
            className="w-full min-h-12 rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-semibold transition hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
          >
            {copied ? "복사됨!" : "복사"}
          </button>

          {/* 안내 메시지 (note) */}
          {data.note && (
            <p className="text-sm text-black/60 dark:text-white/50">
              {data.note}
            </p>
          )}

          {/* 코드 재생성 버튼 */}
          <button
            type="button"
            onClick={handleGenerate}
            className="w-full min-h-12 rounded-xl bg-black/5 px-4 py-3 text-sm font-semibold text-black/70 transition hover:bg-black/10 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/20"
          >
            코드 재생성
          </button>
        </div>
      )}

      {/* 오류 상태: 에러 박스 */}
      {status === "error" && (
        <div className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-900/50 dark:bg-red-950/30">
          <p className="text-sm font-semibold text-red-700 dark:text-red-400">
            오류가 발생했습니다
          </p>
          <p className="text-sm text-red-600 dark:text-red-300">{errorMsg}</p>
          <button
            type="button"
            onClick={handleGenerate}
            className="w-full min-h-12 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-700"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* 기본/로딩 상태: 생성 버튼 */}
      {(status === "idle" || status === "loading") && (
        <button
          type="button"
          onClick={handleGenerate}
          disabled={status === "loading"}
          className="w-full min-h-12 rounded-xl bg-siot-500 px-4 py-4 text-base font-semibold text-white transition hover:bg-siot-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "loading" ? "생성 중…" : "연결 코드 생성"}
        </button>
      )}
    </div>
  );
}
