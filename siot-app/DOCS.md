# 시옷앱 게이트웨이 — HA OS 애드온 설치 가이드

라즈베리파이의 **Home Assistant OS** 위에 시옷앱을 애드온으로 올려, HA(엔진) + 시옷앱(UI/API)을 **한 기기**에서 돌린다.

## 0. 준비
- 라즈베리파이에 Home Assistant OS가 설치되어 동작 중 (이 Pi가 곧 게이트웨이).
- 같은 네트워크의 PC.

## 1. /addons 폴더 접근 수단 설치
설정 → 애드온 → 애드온 스토어에서 둘 중 하나 설치:
- **Advanced SSH & Web Terminal** (SSH로 파일 전송), 또는
- **Samba share** (Windows 탐색기로 `\\homeassistant\addons` 접근 — 가장 쉬움).

## 2. 애드온 파일 복사
이 `siot-app` 폴더 전체를 HA의 `/addons/siot-app/` 에 복사한다.
- Samba면: 탐색기에서 `\\homeassistant\addons\` 안에 `siot-app` 폴더를 통째로 붙여넣기.
- ⚠️ `node_modules`, `.next`, `.siot-data`, `.env.local` 은 **복사하지 않아도 된다**(`.dockerignore`가 빌드에서 제외). 용량·보안상 빼고 올리는 게 좋다.

필수 파일: `config.yaml`, `Dockerfile`, `run.sh`, `.dockerignore`, `package.json`, `package-lock.json`, `app/`, `components/`, `lib/`, `public/`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`.

## 3. 애드온 설치
1. 설정 → 애드온 → (우하단) **애드온 스토어** → 우상단 ⋮ → **새로고침**.
2. 목록 맨 위 **로컬 애드온(Local add-ons)** 에 "시옷앱 게이트웨이"가 보인다 → 클릭 → **설치**.
3. 첫 빌드는 Pi에서 **5~15분** 걸린다(ARM 온디바이스 빌드). 로그 탭에서 진행 확인.

## 4. 시작 & 접속
1. 설치 후 **시작**. (부팅 시 자동 시작되도록 "부팅 시 시작" 켜기)
2. 브라우저에서 **http://homeassistant.local:3000** (또는 `http://<Pi-IP>:3000`) 접속.
3. 홈 화면에 HA의 기기들이 뜨면 성공 — HA 연결은 **자동**이다(아래 참고).

## 5. HA 연결이 자동인 이유
애드온 안에서는 `run.sh`가 HA Supervisor가 주입하는 `SUPERVISOR_TOKEN`을 사용하고,
`http://supervisor/core` 프록시로 HA API를 호출한다. 그래서 **HA 주소·장기토큰을 수동 설정할 필요가 없다.**
- `HA_BASE_URL=http://supervisor/core`
- `HA_TOKEN=<SUPERVISOR_TOKEN>` (자동)
- `SIOT_DATA_DIR=/data` (애드온 영속 볼륨 — gatewayId·gatewayToken 보존)

## 6. 시옷플랫폼 연결(선택)
`/connect` 화면에서 "연결 코드 생성" → 시옷플랫폼이 `POST /siot-app/api/v1/claim`으로 코드를 제시해 `gatewayToken`을 발급받는다(명세서 §4.6). 플랫폼 미구축 시 이 단계는 보류.

## 7. 문제 해결
- **빌드 실패**: 애드온 **로그** 탭 확인. 메모리 부족이면 Pi 재부팅 후 재시도.
- **기기 안 보임 / 502**: 애드온 설정에서 `homeassistant_api: true`가 적용됐는지, HA 코어가 정상인지 확인.
- **3000 포트 접속 불가**: 애드온 **구성/네트워크** 탭에서 3000 포트 매핑 확인.
- **gatewayId가 바뀜**: `/data`가 영속되는지 확인(애드온 재설치 시 `/data` 초기화될 수 있음 → 재등록 필요).

> ⚠️ Matter/Zigbee **실기기 페어링**은 별도 안테나/동글(예: SkyConnect, Sonoff 동글)이 HA에 연결돼 있어야 동작한다. 애드온 배포와는 별개의 하드웨어 요건이다.
