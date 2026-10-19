# 플랫폼/앱 연동 가이드 (Matter 게이트웨이)

기존 시옷앱 게이트웨이 연동 코드는 그대로 동작한다. 이 문서는 **앱에 추가해야 하는 페어링 화면**과 그 API 흐름만 다룬다. 전체 명세는 `openapi.yaml`.

## 1. 등록(claim) — 기존과 동일
1. 사용자가 게이트웨이 로컬 페이지(`http://siot-<shortId>.local:3000`)에서 "등록 코드 발급" → 8자리 코드.
2. 앱에서 코드 입력 → 플랫폼이 `POST /siot-app/api/v1/claim {registrationCode}` → `gatewayToken` 저장.
3. 이후 모든 호출에 `Authorization: Bearer <gatewayToken>`.

앱이 mDNS(`_siot._tcp`)로 게이트웨이를 찾는 기존 로직도 동일하게 동작한다(TXT: `id`, `app:"siot-gateway"`, `url`).

## 2. 기기 페어링 화면 (신규)

```
[앱] 카메라로 기기 QR 스캔  ──▶  "MT:Y.K9042C00KA0648G00"
      또는 11자리 수동 코드 입력 (3497-011-2332)
  │
  ├─ POST /siot-app/api/v1/pairing { "code": "MT:..." }        → 202 { session: { sessionId, stage:"queued" } }
  │
  ├─ 진행 표시 (둘 중 하나)
  │    a) GET /siot-app/api/v1/pairing/{sessionId} 를 1초 간격 폴링
  │    b) 이미 열어둔 SSE(events)의 `event: pairing` 수신
  │       stage: queued → commissioning(시도당 최대 3분, BLE 연결 실패 시 자동 재시도 최대 3회 → 이벤트에 attempt/maxAttempts) → interviewing → done | failed
  │
  └─ done: session.devices[] 를 기기 목록에 추가 (SiotDevice). failed: session.error 표시 후 재시도 버튼
```

안내 문구 권장:
- "기기를 게이트웨이 근처(10m 이내)에 두고 페어링 모드로 만드세요." (IKEA: 배터리 삽입/버튼 4회 등 제품 설명 참고)
- "QR 코드가 인식되지 않으면 기기에 인쇄된 11자리 숫자를 입력하세요."
- 409 응답이면 "다른 기기를 페어링 중입니다. 잠시 후 다시 시도하세요."

## 3. 기기 제거 / 다른 생태계와 공유
- 제거: `DELETE /siot-app/api/v1/devices/{id}` — 기기에서 우리 패브릭이 제거된다.
- Apple Home 등에도 같이 등록: `POST /siot-app/api/v1/devices/{id}/commissioning-window` → 응답의 `setup_manual_code`/`setup_qr_code` 를 화면에 표시(5분 유효).

## 4. 상태/제어
- 문열림 센서: `deviceType: BINARY_SENSOR`, `data.active === true` 가 **열림**, `data.measurement === "door"`, `data.battery` (%).
- 플러그: `deviceType: PLUG`, `data.switch`, `data.power` (W), `data.energy` (kWh).
- 제어 응답의 `device` 는 낙관적 상태이고, 확정 상태는 `events` 로 1초 이내 다시 온다.
- 기기 id 형식이 `matter:<nodeId>:<endpoint>` 로 바뀌었다(기존은 HA entity_id). id 를 파싱하지 말고 불투명 문자열로 다룰 것.

## 5. 호환성 메모
- `GET /system` 과 `SiotDevice` 에 추가 필드(`engine`, `source`, `vendor`, `model`)가 있다. 무시해도 된다.
- 응답 형태 대조 테스트: `matter-gateway-poc/agent/test/platform.test.js`.
