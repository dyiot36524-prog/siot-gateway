// 기기 조회/제어 공용 서비스. 내부 UI API와 시옷플랫폼 API가 함께 쓴다. (단계 7)
// HA 의존(ha-client) + 정규화(device-mapper) + action 매핑(control-map)을 한데 묶는다.
import "server-only";
import { callService, getState, listStates } from "./ha-client";
import { mapEntity, mapStates } from "./device-mapper";
import { resolveServiceCall, SUPPORTED_ACTIONS } from "./control-map";
import type { SiotDevice } from "./types";

/** 지원하지 않는 action 등 제어 요청 자체의 오류. */
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

/** 전체 기기 목록 (정규화). includeAll=true면 HA 시스템 entity까지 포함. */
export async function getDevices(includeAll = false): Promise<SiotDevice[]> {
  const states = await listStates();
  return mapStates(states, { includeAll });
}

export interface ControlResult {
  device: SiotDevice;
  service: string;
}

/** 기기 1개를 action으로 제어하고, 변경 후 권위 상태를 정규화해 반환. */
export async function controlDevice(
  id: string,
  action: string,
): Promise<ControlResult> {
  const call = resolveServiceCall(action);
  if (!call) {
    throw new ControlError(
      `지원하지 않는 action: ${action} (지원: ${SUPPORTED_ACTIONS.join(", ")})`,
    );
  }
  await callService(call.domain, call.service, id);
  const state = await getState(id);
  return { device: mapEntity(state), service: `${call.domain}.${call.service}` };
}
