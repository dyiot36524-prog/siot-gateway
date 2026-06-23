// 시옷 표준 action → HA 서비스 호출 변환. (단계 3)
// 순수 함수 → 단위 테스트로 검증.
//
// 켜기/끄기/토글은 도메인 무관 범용 서비스 `homeassistant.turn_on/turn_off/toggle`을
// 쓴다 → switch / light / fan / input_boolean(가상 토글) 전부 동일하게 동작.
// 밝기·잠금·커버 위치 등 도메인 전용 동작은 후속 단계에서 추가.

export interface ServiceCall {
  domain: string;
  service: string;
}

const ACTION_TO_SERVICE: Record<string, "turn_on" | "turn_off" | "toggle"> = {
  ON: "turn_on",
  TURN_ON: "turn_on",
  SWITCH_ON: "turn_on",
  SWITCH_1_ON: "turn_on",
  PLUG_ON: "turn_on",
  OPEN: "turn_on",
  OFF: "turn_off",
  TURN_OFF: "turn_off",
  SWITCH_OFF: "turn_off",
  SWITCH_1_OFF: "turn_off",
  PLUG_OFF: "turn_off",
  CLOSE: "turn_off",
  TOGGLE: "toggle",
};

/** action 문자열을 HA 서비스 호출로 변환. 지원하지 않는 action이면 null. */
export function resolveServiceCall(action: string): ServiceCall | null {
  const service = ACTION_TO_SERVICE[action.trim().toUpperCase()];
  if (!service) return null;
  return { domain: "homeassistant", service };
}

/** 지원하는 action 목록 (에러 메시지/문서용). */
export const SUPPORTED_ACTIONS = Object.keys(ACTION_TO_SERVICE);
