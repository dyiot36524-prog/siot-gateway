import { describe, it, expect } from "vitest";
import { generateCode, isCodeValid } from "../lib/registration";

describe("generateCode", () => {
  it("8자리 대문자 16진수 문자열을 반환한다", () => {
    const code = generateCode();
    expect(code).toMatch(/^[0-9A-F]{8}$/);
  });

  it("매 호출마다 다른 코드를 생성한다", () => {
    const codes = new Set(Array.from({ length: 10 }, () => generateCode()));
    // 10번 중 최소 2개 이상 달라야 한다 (충돌 확률이 극히 낮음).
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("isCodeValid", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const now = new Date().toISOString();

  it("code가 null이면 false", () => {
    expect(isCodeValid(null, future, now)).toBe(false);
  });

  it("expiresAtIso가 null이면 false", () => {
    expect(isCodeValid("ABCD1234", null, now)).toBe(false);
  });

  it("code와 expiresAt 모두 null이면 false", () => {
    expect(isCodeValid(null, null, now)).toBe(false);
  });

  it("만료된 코드는 false", () => {
    expect(isCodeValid("ABCD1234", past, now)).toBe(false);
  });

  it("미래 만료 시간이면 true", () => {
    expect(isCodeValid("ABCD1234", future, now)).toBe(true);
  });

  it("nowIso가 expiresAtIso와 정확히 같으면 true (경계: now > expiresAt이 false이므로 아직 유효)", () => {
    // now === expiresAt 이면 now > expiresAt 조건이 false → 만료로 간주하지 않음.
    const same = future;
    expect(isCodeValid("ABCD1234", same, same)).toBe(true);
  });
});
