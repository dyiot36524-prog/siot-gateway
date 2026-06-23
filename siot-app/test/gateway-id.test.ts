import { describe, it, expect } from "vitest";
import { deriveGatewayId, SIOT_NAMESPACE, shouldReprovision } from "../lib/gateway-id";

describe("deriveGatewayId", () => {
  it("같은 시리얼이면 항상 같은 ID를 반환한다 (결정적)", () => {
    const id1 = deriveGatewayId("ABC123");
    const id2 = deriveGatewayId("ABC123");
    expect(id1).toBe(id2);
  });

  it("다른 시리얼이면 서로 다른 ID를 반환한다", () => {
    const id1 = deriveGatewayId("SERIAL_A");
    const id2 = deriveGatewayId("SERIAL_B");
    expect(id1).not.toBe(id2);
  });

  it("serial이 null이면 'gw_'로 시작하는 ID를 반환한다 (무작위)", () => {
    const id = deriveGatewayId(null);
    expect(id).toMatch(/^gw_/);
  });

  it("serial이 truthy면 'gw_'로 시작하는 결정적 ID를 반환한다", () => {
    const id = deriveGatewayId("RASPI-001");
    expect(id).toMatch(/^gw_/);
  });

  it("null 시리얼은 매 호출마다 다른 ID를 생성한다 (무작위)", () => {
    const id1 = deriveGatewayId(null);
    const id2 = deriveGatewayId(null);
    // 확률적으로 같을 수 있지만 UUID v4 충돌 확률은 무시.
    expect(id1).not.toBe(id2);
  });

  it("SIOT_NAMESPACE 상수가 올바른 UUID 형식이다", () => {
    expect(SIOT_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("shouldReprovision", () => {
  it("두 값이 모두 null이면 false (비교 불가)", () => {
    expect(shouldReprovision(null, null)).toBe(false);
  });

  it("storedSerial이 undefined이고 currentSerial이 있으면 false (비교 불가)", () => {
    expect(shouldReprovision(undefined, "abc")).toBe(false);
  });

  it("storedSerial이 있고 currentSerial이 null이면 false (현재 시리얼 읽기 실패)", () => {
    expect(shouldReprovision("abc", null)).toBe(false);
  });

  it("두 시리얼이 동일하면 false (같은 기기)", () => {
    expect(shouldReprovision("abc", "abc")).toBe(false);
  });

  it("두 시리얼이 모두 truthy이고 서로 다르면 true (SSD 복제 감지)", () => {
    expect(shouldReprovision("abc", "xyz")).toBe(true);
  });

  it("두 값이 모두 빈 문자열(falsy)이면 false", () => {
    expect(shouldReprovision("", "")).toBe(false);
  });
});
