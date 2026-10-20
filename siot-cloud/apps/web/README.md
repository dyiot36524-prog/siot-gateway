# @siot/web — 기사 PWA (M1)

계약: `../api/openapi/app-v1.yaml`. 같은 origin 쿠키 세션, SSE `/app/v1/sites/{siteId}/events`.

```sh
npm -w apps/web run dev            # /app/v1 → localhost:8080 프록시
npm -w apps/web run dev:mock       # 백엔드 없이 msw 목(src/mocks)으로 화면 흐름 확인
npm -w apps/web run build:mock && npm -w apps/web run preview:mock
npm -w apps/web test               # vitest + RTL + msw/node
```

목 계정 `gisa@siot.dev` / `siot-demo-1234`. 라벨 `siot-3f9a2c71` + `9C2E-41AB-77D0-5E18`(성공), `siot-b0d5e811` + `AAAA-1111-BBBB-2222`(다른 업체 403).
끝자리 9 인 기기 코드는 첫 시도에 "기기 안 잡힘"으로 실패한다(재시도 확인용).

화면: 로그인 → 세대 목록/생성 → 세대 상세 → GW 추가(QR·수동) → 페어링(GW 별 큐) → 전체 점검 → 로그아웃. `/g/<gatewayId>#<secret>` 는 라벨 QR 딥링크.
거주자(`/home`)·운영자(`/ops`)는 자리만 있다(M2). 스크린샷은 `docs/`.
