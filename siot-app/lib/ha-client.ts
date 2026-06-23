// HA(Home Assistant) 호출 래퍼 — 시옷앱의 모든 HA 통신은 여기 한 곳에 모은다.
// 엔진(HA)이 바뀌면 이 파일만 교체하면 되도록 격리한다. (가이드 6절)
// 토큰은 서버 전용 — 이 모듈은 절대 클라이언트 번들에 포함되면 안 된다.
import { HaClientError, type HaState } from "./types";

import "server-only";

const DEFAULT_TIMEOUT_MS = 10_000;

interface HaConfig {
  baseUrl: string;
  token: string;
}

/** 환경변수에서 HA 설정을 읽고 검증한다. 누락 시 명확한 에러를 던진다. */
function getConfig(): HaConfig {
  const baseUrl = process.env.HA_BASE_URL;
  const token = process.env.HA_TOKEN;

  if (!baseUrl) {
    throw new HaClientError(
      "HA_BASE_URL 환경변수가 없습니다. .env.local을 확인하세요.",
    );
  }
  if (!token || token === "여기에_토큰_붙여넣기") {
    throw new HaClientError(
      "HA_TOKEN 환경변수가 비어있습니다. HA 장기 액세스 토큰을 .env.local에 넣으세요.",
    );
  }
  // 끝의 슬래시 제거로 경로 조합을 일관되게.
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** HA REST API에 인증 요청을 보내고 JSON을 파싱한다. */
async function haFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, token } = getConfig();
  const url = `${baseUrl}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new HaClientError(`HA 응답 시간 초과 (${url})`);
    }
    throw new HaClientError(
      `HA에 연결할 수 없습니다 (${url}). 주소/네트워크를 확인하세요. 원인: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!res.ok) {
    const hint =
      res.status === 401
        ? " (토큰이 잘못됐거나 만료됨)"
        : res.status === 404
          ? " (경로 없음 — HA 버전/엔드포인트 확인)"
          : "";
    throw new HaClientError(
      `HA 요청 실패 ${res.status} ${res.statusText}${hint}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

/** HA의 모든 엔티티 상태 목록을 가져온다. `GET /api/states`. */
export function listStates(): Promise<HaState[]> {
  return haFetch<HaState[]>("/api/states");
}

/** HA 연결 가능 여부를 빠르게 확인한다. `GET /api/` (running 메시지 반환). */
export async function ping(): Promise<boolean> {
  await haFetch<{ message: string }>("/api/");
  return true;
}

/**
 * HA 서비스를 호출한다. `POST /api/services/{domain}/{service}`.
 * 예: callService("homeassistant", "turn_on", "input_boolean.siot_test_plug").
 * 반환값은 이 호출로 상태가 바뀐 엔티티들의 새 상태 배열.
 */
export function callService(
  domain: string,
  service: string,
  entityId: string,
): Promise<HaState[]> {
  return haFetch<HaState[]>(`/api/services/${domain}/${service}`, {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId }),
  });
}

/** 단일 엔티티의 현재 상태를 조회한다. `GET /api/states/{entity_id}`. */
export function getState(entityId: string): Promise<HaState> {
  return haFetch<HaState>(`/api/states/${entityId}`);
}
