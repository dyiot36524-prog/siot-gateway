# 중립 디바이스 모델 (v0)

목표: Matter / Zigbee / LifeSmart 등 소스가 달라도 플랫폼(자동화·대시보드·앱)은 같은 구조만 본다.

## Device
```jsonc
{
  "id": "matter:12",              // "<source>:<source-local-id>"
  "source": "matter",             // matter | zigbee | lifesmart
  "online": true,
  "info": { "vendorId": 4476, "vendorName": "IKEA of Sweden", "productName": "GRILLPLATS", "serial": "...", "swVersion": "1.0.0" },
  "commissionedAt": "2026-10-14T...",
  "endpoints": {
    "1": {
      "id": 1,
      "kinds": ["onoff_plug"],      // Matter 디바이스타입에서 유도
      "capabilities": {
        "onoff":  { "on": true },
        "power":  { "watts": 12.5, "volts": 220.1, "amps": 0.06 },
        "energy": { "kwh": 2.5 }
      }
    }
  }
}
```

## Capability 사전 (필드 단위가 상태의 최소 단위)
| capability | fields | Matter 출처 |
|---|---|---|
| onoff | on:bool | OnOff(0x0006).OnOff |
| level | percent:0-100 | LevelControl(0x0008).CurrentLevel |
| contact | open:bool | BooleanState(0x0045).StateValue (true=닫힘 → open=false) |
| battery | percent:0-100, low:bool | PowerSource(0x002F).BatPercentRemaining(0.5% 단위), BatChargeLevel |
| power | watts, volts, amps | ElectricalPowerMeasurement(0x0090) mW/mV/mA |
| energy | kwh | ElectricalEnergyMeasurement(0x0091).CumulativeEnergyImported.energy(mWh) |
| motion | detected:bool | OccupancySensing(0x0406).Occupancy bit0 |
| temperature | celsius | TemperatureMeasurement(0x0402).MeasuredValue/100 |
| humidity | percent | RelativeHumidity(0x0405).MeasuredValue/100 |
| illuminance | lux | IlluminanceMeasurement(0x0400) 로그 스케일 변환 |

추가 시 규칙: capability 이름은 소스 중립, 단위는 SI 기본(°C, W, kWh, %).

## 명령
```json
{ "reqId": "r1", "deviceId": "matter:12", "endpoint": 1, "capability": "onoff", "action": "on", "params": {} }
```
지원: onoff.on/off/toggle/set{on}, level.set{percent,transitionTime}

## 상태 변경 이벤트
```json
{ "deviceId": "matter:7", "endpoint": 1, "capability": "contact", "field": "open", "value": true, "prev": false, "at": 1760400000000 }
```

## 로컬 규칙
```jsonc
{
  "id": "door-open-turns-plug-on",
  "enabled": true,
  "trigger":    { "deviceId": "matter:7", "capability": "contact", "field": "open", "changedTo": true },   // 또는 "equals"
  "conditions": [ { "deviceId": "matter:12", "capability": "onoff", "field": "on", "equals": false } ],    // equals | gt | lt
  "actions": [
    { "type": "command", "deviceId": "matter:12", "capability": "onoff", "action": "on" },
    { "type": "delay", "ms": 5000 },
    { "type": "mqtt", "topic": "events/door", "payload": { "msg": "opened" } }
  ]
}
```
클라우드는 `gw/<id>/rules/set` 로 규칙 전체를 내려보내고, 게이트웨이는 data/rules.json 에 저장해 오프라인에서도 실행한다.
> 2026-10 갱신: MQTT 토픽은 **WebSocket 릴레이로 대체**되었다. 규칙은 relay-v2 `cfg.rules {version, rules[]}` 로 내려오고 `cfg_ack.rulesVersion` 으로 확인한다(`docs/relay-protocol.md`). M1 에이전트는 cfg 를 `data/agent/site.json` 에 저장·ack 만 하고, 규칙 엔진 반영은 Step 5 에서 붙인다. 로컬 규칙 파일은 `/app/data/rules.json`.

## 다음 단계
- Zigbee 소스: zigpy 또는 Zigbee2MQTT → 같은 capability 로 매핑하는 어댑터 추가 (id 접두어 `zigbee:`)
- LifeSmart 소스: 기존 허브의 devtype/idx/val 을 capability 로 매핑 (id 접두어 `lifesmart:`), 플랫폼 쪽 어댑터로 처리 가능
- 디바이스 타입 ID 누락 시 `unknown_<id>` 로 표시되므로 로그를 보고 사전에 추가
