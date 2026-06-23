// 페어링 비즈니스 로직 — classifyProtocol + HA 가상 기기 생성을 조합한다.
// HA 접근을 포함하므로 서버 전용.
import "server-only";

import { mapEntity } from "./device-mapper";
import { createVirtualDevice } from "./ha-pairing";
import { classifyProtocol } from "./pairing-map";
import type { SiotDevice } from "./types";

/** pairDevice 반환 유니온 타입. */
export type PairResult =
  | { status: "paired"; device: SiotDevice }
  | { status: "unsupported"; message: string }
  | { status: "invalid" };

/**
 * protocol 문자열을 받아 페어링을 시도한다.
 * - DEMO: HA에 가상 input_boolean 생성 후 SiotDevice로 변환해 반환.
 * - MATTER/ZIGBEE: 실물 하드웨어 필요 안내 메시지 반환.
 * - 그 외: invalid 반환.
 * HA 오류 시 HaClientError가 그대로 throw된다 (라우트에서 catch).
 */
export async function pairDevice(protocol: string): Promise<PairResult> {
  const classified = classifyProtocol(protocol);

  switch (classified.kind) {
    case "demo": {
      const haState = await createVirtualDevice();
      const device = mapEntity(haState);
      return { status: "paired", device };
    }
    case "unsupported":
      return { status: "unsupported", message: classified.message };
    case "invalid":
      return { status: "invalid" };
  }
}
