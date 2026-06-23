// HA WebSocket으로 가상 기기(input_boolean)를 생성하는 서버 전용 모듈.
// scripts/ha-create-toggle.mjs의 WebSocket 메시지 처리 방식을 라이브러리 함수로 전환.
import "server-only";

import { randomBytes } from "node:crypto";
import { getState } from "./ha-client";
import { HaClientError, type HaState } from "./types";

const TIMEOUT_MS = 15_000;

/** HA WebSocket result 메시지의 성공 응답 형태. */
interface WsResultSuccess {
  type: "result";
  id: number;
  success: true;
  result: { id: string };
}

/** HA WebSocket result 메시지의 실패 응답 형태. */
interface WsResultFailure {
  type: "result";
  id: number;
  success: false;
  error: { code: string; message: string };
}

type WsMessage =
  | { type: "auth_required" }
  | { type: "auth_ok" }
  | { type: "auth_invalid"; message: string }
  | WsResultSuccess
  | WsResultFailure;

/**
 * HA에 가상 input_boolean 기기를 생성하고 생성된 엔티티의 HaState를 반환한다.
 * - HA_BASE_URL 환경변수에서 WebSocket URL 도출 (http→ws 변환).
 * - 15초 타임아웃, 실패 시 HaClientError throw.
 */
export function createVirtualDevice(): Promise<HaState> {
  return new Promise<HaState>((resolve, reject) => {
    const baseUrl = process.env.HA_BASE_URL;
    const token = process.env.HA_TOKEN;

    if (!baseUrl) {
      reject(
        new HaClientError(
          "HA_BASE_URL 환경변수가 없습니다. .env.local을 확인하세요.",
        ),
      );
      return;
    }
    if (!token || token === "여기에_토큰_붙여넣기") {
      reject(
        new HaClientError(
          "HA_TOKEN 환경변수가 비어있습니다. HA 장기 액세스 토큰을 .env.local에 넣으세요.",
        ),
      );
      return;
    }

    // http(s):// → ws(s):// 변환, 끝 슬래시 제거.
    const wsUrl =
      baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/api/websocket";

    // 이름에 3바이트 hex를 붙여 충돌 방지.
    const hex = randomBytes(3).toString("hex");
    const name = `Siot Demo ${hex}`;

    const ws = new WebSocket(wsUrl);

    const timer = setTimeout(() => {
      ws.close();
      reject(new HaClientError("HA WebSocket 응답 시간 초과 (15초)"));
    }, TIMEOUT_MS);

    // 타임아웃·reject·resolve 후 정리.
    function finish(fn: () => void) {
      clearTimeout(timer);
      fn();
    }

    ws.addEventListener("message", (ev: MessageEvent<string>) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(ev.data) as WsMessage;
      } catch {
        // JSON 파싱 실패는 무시 (HA ping 메시지 등).
        return;
      }

      if (msg.type === "auth_required") {
        // 인증 요청 수신 → 토큰 전송.
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_invalid") {
        ws.close();
        finish(() =>
          reject(
            new HaClientError(
              `HA WebSocket 인증 실패: ${(msg as { type: "auth_invalid"; message: string }).message}`,
              401,
            ),
          ),
        );
      } else if (msg.type === "auth_ok") {
        // 인증 성공 → input_boolean 생성 요청.
        ws.send(
          JSON.stringify({
            id: 1,
            type: "input_boolean/create",
            name,
            icon: "mdi:plus-circle",
          }),
        );
      } else if (msg.type === "result" && msg.id === 1) {
        ws.close();
        if (msg.success) {
          const entityId = `input_boolean.${(msg as WsResultSuccess).result.id}`;
          // REST API로 방금 생성된 엔티티 상태 조회 후 반환.
          finish(() => {
            getState(entityId).then(resolve).catch((err: unknown) => {
              reject(
                err instanceof HaClientError
                  ? err
                  : new HaClientError(
                      `가상 기기 상태 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
                    ),
              );
            });
          });
        } else {
          const errMsg = (msg as WsResultFailure).error?.message ?? "알 수 없는 오류";
          finish(() =>
            reject(
              new HaClientError(`HA input_boolean 생성 실패: ${errMsg}`),
            ),
          );
        }
      }
    });

    ws.addEventListener("error", (e: Event) => {
      ws.close();
      finish(() =>
        reject(
          new HaClientError(
            `HA WebSocket 연결 오류: ${e instanceof ErrorEvent ? e.message : "네트워크 오류"}`,
          ),
        ),
      );
    });
  });
}
