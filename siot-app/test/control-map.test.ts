import { describe, it, expect } from "vitest";
import { resolveServiceCall } from "../lib/control-map";

describe("resolveServiceCall", () => {
  it("켜기 계열 action은 homeassistant.turn_on", () => {
    for (const a of ["ON", "TURN_ON", "PLUG_ON", "SWITCH_1_ON"]) {
      expect(resolveServiceCall(a)).toEqual({
        domain: "homeassistant",
        service: "turn_on",
      });
    }
  });

  it("끄기 계열 action은 homeassistant.turn_off", () => {
    for (const a of ["OFF", "TURN_OFF", "PLUG_OFF", "SWITCH_1_OFF"]) {
      expect(resolveServiceCall(a)).toEqual({
        domain: "homeassistant",
        service: "turn_off",
      });
    }
  });

  it("TOGGLE은 homeassistant.toggle", () => {
    expect(resolveServiceCall("TOGGLE")).toEqual({
      domain: "homeassistant",
      service: "toggle",
    });
  });

  it("대소문자/공백 무시", () => {
    expect(resolveServiceCall("  on  ")).toEqual({
      domain: "homeassistant",
      service: "turn_on",
    });
  });

  it("지원하지 않는 action은 null", () => {
    expect(resolveServiceCall("EXPLODE")).toBeNull();
    expect(resolveServiceCall("")).toBeNull();
  });
});
