# 시옷앱 게이트웨이

라즈베리파이의 **Home Assistant(엔진)** 위에서 도는 게이트웨이 애플리케이션. 현장 IoT 기기를 페어링·제어하고, 시옷플랫폼과 연동하는 UI/API를 제공한다.

## 기능
- **기기 제어/모니터링** — HA 기기를 시옷 표준 모델로 정규화해 표시·제어 (웹 `:3000`)
- **페어링** — 새 기기 추가 화면 (`/pairing`, 데모/Matter/Zigbee)
- **실시간** — HA 상태 변경을 SSE로 즉시 반영
- **게이트웨이 식별** — 하드웨어 시리얼 기반 UUIDv5 고유 ID(자동), 클론 안전장치
- **시옷플랫폼 연동** — 인증 API(`/siot-app/api/v1/*`), 등록·클레임, 상태 폴링

## 설치 / 배포
- **HA OS 애드온**으로 설치: [DOCS.md](DOCS.md)
- 일반 리눅스/도커 배포 및 GitHub 저장소 업데이트: [DEPLOY.md](DEPLOY.md)
- 양산·함대 관리: [../FLEET.md](../FLEET.md)

## 개발 (로컬)
```bash
npm install
npm run dev      # http://localhost:3000  (.env.local에 HA_BASE_URL/HA_TOKEN 필요)
npm test         # 단위 테스트
```

HA 연동 인터페이스 명세는 시옷플랫폼 팀과 합의 중(내부 문서).
