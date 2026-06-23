import { describe, it, expect } from "vitest";
import { classifyProtocol } from "../lib/pairing-map";

describe("classifyProtocol", () => {
  it("'DEMO'는 {kind:'demo'}", () => {
    expect(classifyProtocol("DEMO")).toEqual({ kind: "demo" });
  });

  it("소문자·공백 포함 ' demo '도 {kind:'demo'}", () => {
    expect(classifyProtocol(" demo ")).toEqual({ kind: "demo" });
  });

  it("'MATTER'는 unsupported (message 포함)", () => {
    const result = classifyProtocol("MATTER");
    expect(result.kind).toBe("unsupported");
    expect((result as { kind: "unsupported"; message: string }).message).toContain(
      "Matter/Zigbee 페어링은 실물 안테나/동글이 필요합니다",
    );
  });

  it("'ZIGBEE'는 unsupported (message 포함)", () => {
    const result = classifyProtocol("ZIGBEE");
    expect(result.kind).toBe("unsupported");
    expect((result as { kind: "unsupported"; message: string }).message).toContain(
      "Matter/Zigbee 페어링은 실물 안테나/동글이 필요합니다",
    );
  });

  it("알 수 없는 값 'FOO'는 {kind:'invalid'}", () => {
    expect(classifyProtocol("FOO")).toEqual({ kind: "invalid" });
  });

  it("빈 문자열 ''은 {kind:'invalid'}", () => {
    expect(classifyProtocol("")).toEqual({ kind: "invalid" });
  });
});
