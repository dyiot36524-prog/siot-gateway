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
파일 `/app/data/rules.json` = `{ "version": 3, "rules": [ … ] }`. `version` 없음/0 = 손으로 쓴 로컬 규칙, ≥1 = 플랫폼이 relay-v2 `cfg.rules {version, rules[]}` 로 내려보낸 것(스키마 `relay-v2.json` `$defs.Rule`).
```jsonc
{
  "id": "aut_01…",
  "name": "문 열리면 플러그 켜기",   // 선택
  "enabled": true,
  "trigger":                                                     // type 생략 = device(옛 규칙 호환)
      { "type": "device", "deviceId": "matter:7", "endpoint": 1, "capability": "contact", "field": "open", "changedTo": true }   // 또는 "equals"
    | { "type": "schedule", "at": "22:00", "days": ["mon","tue"], "tz": "Asia/Seoul" },   // days 생략 = 매일, tz 생략 = Asia/Seoul
  "conditions": [ { "deviceId": "matter:12", "capability": "onoff", "field": "on", "equals": false } ],    // equals | gt | lt
  "actions": [
    { "type": "command", "deviceId": "matter:12", "capability": "onoff", "action": "on" },
    { "type": "delay", "ms": 5000 }
  ]
}
```
- **적용**: 에이전트는 `cfg` 를 받으면 `rules.json` 을 원자적으로 교체하고 `rules installed v<N>` 을 남긴다. 같거나 낮은 version 재전송은 무시(멱등), `version 0 + 빈 배열`(플랫폼이 아직 안 보냄)은 손으로 쓴 규칙을 지우지 않도록 무시. 확인은 `cfg_ack.rulesVersion`.
- **schedule**: 30초 틱, 규칙의 tz 기준 `YYYY-MM-DD HH:MM` 키로 분당 1회. `days` 도 tz 기준 요일.
- **시계 게이트**: Pi 는 RTC 가 없어 NTP 동기 전 시계가 틀리다. `SIOT_CLOCK_SYNC_FILE`(compose: `/host/systemd/timesync/synchronized` ← 호스트 `/run/systemd`(timesyncd 재시작 시 하위 디렉터리가 재생성되므로 상위를 마운트))이 생길 때까지 schedule 규칙은 보류(WARN 1회), 동기 후 밀린 분은 실행하지 않는다. 상태는 `health.json` 의 `clockSynced`. device 트리거는 영향 없음.
- 옛 `mqtt` 액션은 무시한다(오류 아님). 클라우드 단절 중에도 저장된 규칙으로 계속 동작한다.

## 다음 단계
- Zigbee 소스: zigpy 또는 Zigbee2MQTT → 같은 capability 로 매핑하는 어댑터 추가 (id 접두어 `zigbee:`)
- LifeSmart 소스: 기존 허브의 devtype/idx/val 을 capability 로 매핑 (id 접두어 `lifesmart:`), 플랫폼 쪽 어댑터로 처리 가능
- 디바이스 타입 ID 누락 시 `unknown_<id>` 로 표시되므로 로그를 보고 사전에 추가
