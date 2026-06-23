import { describe, it, expect } from "vitest";
import {
  mapEntity,
  mapStates,
  resolveDeviceType,
} from "../lib/device-mapper";
import type { HaState } from "../lib/types";

// 테스트용 HaState 생성 헬퍼.
function ha(
  entity_id: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HaState {
  return {
    entity_id,
    state,
    attributes,
    last_changed: "2026-06-22T00:00:00+00:00",
    last_updated: "2026-06-22T00:00:00+00:00",
    context: { id: "x", parent_id: null, user_id: null },
  };
}

describe("resolveDeviceType", () => {
  it("outlet device_class면 PLUG, 아니면 SWITCH", () => {
    expect(resolveDeviceType("switch", "outlet")).toBe("PLUG");
    expect(resolveDeviceType("switch", null)).toBe("SWITCH");
  });

  it("도메인별 매핑", () => {
    expect(resolveDeviceType("light", null)).toBe("LIGHT");
    expect(resolveDeviceType("sensor", "temperature")).toBe("SENSOR");
    expect(resolveDeviceType("binary_sensor", "motion")).toBe("BINARY_SENSOR");
    expect(resolveDeviceType("cover", null)).toBe("COVER");
    expect(resolveDeviceType("lock", null)).toBe("LOCK");
  });

  it("모르는 도메인은 UNKNOWN", () => {
    expect(resolveDeviceType("camera", null)).toBe("UNKNOWN");
  });
});

describe("mapEntity", () => {
  it("가이드 검증 케이스: 플러그가 {deviceType:'PLUG', data:{switch:true}}로 나옴", () => {
    const d = mapEntity(
      ha("switch.living_plug", "on", {
        device_class: "outlet",
        friendly_name: "거실 플러그",
      }),
    );
    expect(d.deviceType).toBe("PLUG");
    expect(d.data.switch).toBe(true);
    expect(d.name).toBe("거실 플러그");
    expect(d.online).toBe(true);
    expect(d.id).toBe("switch.living_plug");
  });

  it("off 플러그는 switch:false", () => {
    const d = mapEntity(ha("switch.plug", "off", { device_class: "outlet" }));
    expect(d.data.switch).toBe(false);
  });

  it("전력 측정 플러그는 power 노출", () => {
    const d = mapEntity(
      ha("switch.plug", "on", { device_class: "outlet", current_power_w: 12.3 }),
    );
    expect(d.data.power).toBe(12.3);
  });

  it("숫자 센서는 value(숫자)+unit+measurement", () => {
    const d = mapEntity(
      ha("sensor.temp", "21.5", {
        unit_of_measurement: "°C",
        device_class: "temperature",
      }),
    );
    expect(d.deviceType).toBe("SENSOR");
    expect(d.data.value).toBe(21.5);
    expect(d.data.unit).toBe("°C");
    expect(d.data.measurement).toBe("temperature");
  });

  it("비숫자 센서는 value를 원문 문자열로", () => {
    const d = mapEntity(ha("sensor.state", "idle"));
    expect(d.data.value).toBe("idle");
  });

  it("light 밝기는 0~255 → 0~100 정규화", () => {
    const d = mapEntity(ha("light.lamp", "on", { brightness: 255 }));
    expect(d.data.switch).toBe(true);
    expect(d.data.brightness).toBe(100);
  });

  it("binary_sensor는 active 불리언", () => {
    const d = mapEntity(ha("binary_sensor.door", "on", { device_class: "door" }));
    expect(d.data.active).toBe(true);
    expect(d.data.measurement).toBe("door");
  });

  it("unavailable이면 online=false", () => {
    const d = mapEntity(ha("switch.plug", "unavailable"));
    expect(d.online).toBe(false);
  });

  it("friendly_name 없으면 entity_id를 name으로", () => {
    const d = mapEntity(ha("switch.x", "on"));
    expect(d.name).toBe("switch.x");
  });
});

describe("mapStates", () => {
  it("HA 시스템 entity는 기본 제외, 실제 기기만 반환", () => {
    const states = [
      ha("switch.plug", "on", { device_class: "outlet" }),
      ha("update.core", "off"),
      ha("sun.sun", "above_horizon"),
      ha("person.gwangsu", "home"),
      ha("sensor.temp", "21.5"),
    ];
    const devices = mapStates(states);
    const ids = devices.map((d) => d.id);
    expect(ids).toContain("switch.plug");
    expect(ids).toContain("sensor.temp");
    expect(ids).not.toContain("update.core");
    expect(ids).not.toContain("sun.sun");
    expect(ids).not.toContain("person.gwangsu");
    expect(devices).toHaveLength(2);
  });

  it("includeAll=true면 전부 포함", () => {
    const states = [
      ha("switch.plug", "on"),
      ha("update.core", "off"),
    ];
    expect(mapStates(states, { includeAll: true })).toHaveLength(2);
  });
});
