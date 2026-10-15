# Matter/Thread 게이트웨이 설계 메모 (2026-10-14)

## 1. 구매 장비 점검

| 항목 | 판정 | 비고 |
|---|---|---|
| Raspberry Pi 5 8GB + 어댑터 + 쿨러 | 적합 | BLE 내장이라 게이트웨이 측 커미셔닝 가능. 단, Pi 온보드 BLE가 불안정하다는 보고가 있어 실측 필요 |
| 공식 M.2 HAT+ | 적합 | 2230/2242 NVMe 전용, PCIe Gen2. NVMe 부팅은 EEPROM(부트로더) 업데이트 후 가능 |
| SK hynix BC901 2242 256GB | 아마 적합(미검증) | 2242 NVMe라 규격은 맞음. 이 모델의 Pi 5 호환 보고는 못 찾았음. SD로 먼저 부팅해 Imager로 NVMe에 쓰는 절차 권장 |
| Home Assistant Connect ZBT-2 | 적합 | 칩은 EFR32MG24(ESP32-S3는 USB-시리얼 브리지). 펌웨어는 Zigbee 또는 Thread 중 하나만 올림. Thread용 `zbt2_openthread_rcp` 펌웨어(460800 baud)로 OTBR의 RCP로 동작 |

주의: ZBT-2는 Pi 5의 USB 2.0 포트(검정)에 꽂거나 짧은 연장 케이블로 보드에서 떼어 놓아야 2.4GHz 간섭이 줄어듦. Zigbee까지 하려면 동글이 하나 더 필요.

## 2. "Home Assistant는 무겁고 자유도가 낮다" — 여전히 맞음, 단 결론이 달라짐

- HA Core 전체를 제품 코어로 쓰는 것은 여전히 비추천: Python 모놀리스, 엔티티 모델/인증/UI가 강제, 화이트라벨 어려움, 커미셔닝 UX가 컴패니언 앱에 묶임.
- 2026년 6월 HA는 Matter 컨트롤러를 **matter.js(TypeScript) 기반 matterjs-server 9.0**으로 교체했고, 기존 python-matter-server는 deprecated/archived(최종 8.1.2).
- matterjs-server는 Apache-2.0, Docker 단독 실행(포트 5580, WebSocket `/ws`), "다른 프로젝트에서 쓰도록 의도됨"이라고 명시. HA 없이 쓸 수 있음.
- 따라서 정답은 "HA를 버린다"가 아니라 "HA에서 나온 부품(OTBR, matterjs-server 또는 matter.js 라이브러리)만 떼어 쓰고, 나머지는 자사 코드로 만든다".

선택지:
- A. HA Core 통째 + REST/WS API: 가장 빠르지만 무겁고 제약 큼. 비추천.
- B. OTBR 컨테이너 + matterjs-server 컨테이너 + 자사 gateway-agent: PoC 및 1차 제품에 권장.
- C. matter.js 라이브러리(@matter/main + @matter/nodejs-ble)로 자사 컨트롤러 직접 작성: 자유도 최대, 인증 시 유리. B로 검증 후 이행.
- D. CHIP SDK(C++) chip-tool/직접 빌드: 제어력 최대, 비용 최대. 비추천.

핵심 리스크: matterjs-server README는 단독 `--ble` 모드에서 "Thread 커미셔닝은 네트워크 이름이 제공되지 않아 미지원"이라고 적음. HA 컴패니언 앱/BLE 프록시 경로만 검증된 상태. 반면 matter.js 셸은 `config thread-credentials set <NetworkName> <dataset>` 후 BLE→Thread 커미셔닝이 문서화됨. 1주차 검증 포인트.

## 3. 목표 아키텍처

게이트웨이(Pi 5, Raspberry Pi OS 64-bit Lite, 컨테이너 3개)
1. otbr: ZBT-2(RCP, 460800) + 백본 인터페이스 eth0/wlan0. Thread 네트워크 생성, 데이터셋 보관.
2. matterjs-server(또는 자사 matter.js 컨트롤러): host network, BLE는 `NOBLE_BINDINGS=dbus`, fabric 데이터 볼륨, VENDOR_ID.
3. gateway-agent(자사): matter 서버 WS 구독(start_listening) → 자사 디바이스 모델로 정규화 → MQTT over TLS(게이트웨이별 mTLS 인증서)로 플랫폼 연결, 페어링 세션 API, 로컬 클레임(QR/mDNS), OTA.

플랫폼/앱
- 게이트웨이 레지스트리 + 클레임 플로우(박스 QR → 앱 → 클라우드 → 게이트웨이 토큰 교환)
- 페어링 세션: 앱이 Matter QR(MT:...)/수동 코드 스캔 → 클라우드 → 게이트웨이가 `set_thread_dataset` + `commission_with_code` 실행 → 진행 상태(BLE 발견 → PASE → 인증 → Thread 가입 → CASE) 앱에 스트리밍
- 디바이스 모델 어댑터: Matter 엔드포인트/클러스터를 기존 LifeSmart식 모델에 매핑해 자동화·대시보드가 그대로 동작

IKEA 매핑
- GRILLPLATS 플러그: OnOff(0x0006), Electrical Power/Energy Measurement(0x0090/0x0091)
- MYGGBETT 문열림: BooleanState(0x0045), PowerSource(0x002F, AAA 1개). 슬리피 엔드디바이스 → UDP conntrack 타임아웃 ≥1800(권장 3600)

네트워크 필수 설정
- IPv6 활성, accept_ra 처리, `accept_ra_rt_info_max_plen=64`. OTBR은 forwarding=1이 필요하므로 같은 호스트에서는 `accept_ra=2`로.
- Docker가 IPv6 forwarding을 리셋하므로 docker 이후 실행되는 systemd 유닛으로 재설정.
- 평탄한 LAN, mDNS 리플렉터 금지, Matter UDP를 포트 기준으로 필터링하지 말 것.
- DCL(증명서 검증) 접근을 위해 인터넷 필요(오프라인 시 번들 시드 사용).

인증/법무
- matterjs-server 기본 VID 0xFFF1은 테스트용. 상용 컨트롤러는 CSA 회원가입 후 Vendor ID 발급·인증 필요(2026년 회비는 확인 못 함, CSA 문의).
- Thread 인증(보더 라우터)은 Thread Group Contributor 이상 회원 필요. OpenThread 실행 자체에는 회원 불필요.
- 양산은 Pi 5 대신 CM5 캐리어 또는 자체 보드 + MG24 모듈(UART) 검토.

## 4. 결정이 필요한 질문

1. 커미셔닝 주체: 게이트웨이 BLE(권장) vs 폰(iOS MatterSupport/Android Home APIs, 멀티 패브릭 복잡)
2. 디바이스 모델: 기존 LifeSmart 모델에 억지로 맞출지, Matter 클러스터 기반 중립 모델을 새로 두고 LifeSmart도 그 위에 얹을지
3. 로컬 자동화(클라우드 단절 시 동작) 필요 여부 → 게이트웨이 룰 엔진
4. Zigbee 범위 포함 여부(동글 추가, zigpy/Zigbee2MQTT)
5. gateway-agent 언어: matter.js가 TS라 Node/TS가 자연스러움. 팀 역량?
6. 멀티 어드민(사용자가 Apple Home 등과 동시 사용) 지원 여부
7. 기존 LifeSmart 허브와의 관계: 병렬 vs 대체
8. 제품화 일정, CSA/Thread Group 예산, 양산 하드웨어

## 5. 단계별 일정(안)

- 1주: NVMe 부팅, ZBT-2 ot-rcp 플래시, OTBR 컨테이너, Thread 네트워크 형성(`ot-ctl dataset active -x`)
- 1–2주: matterjs-server 단독 실행 + BLE(dbus). MYGGBETT/GRILLPLATS를 WS API로 커미셔닝. 실패 시 @matter/nodejs-shell의 thread-credentials 경로로 재검증. 수일간 슬리피 장치 구독 안정성 측정
- 3–4주: gateway-agent 골격(WS 클라이언트, 모델 매핑, MQTT, 페어링 세션 API), 앱 QR 스캔 → 페어링
- 5–6주: 플랫폼 통합(게이트웨이 클레임, 자동화/대시보드 어댑터, OTA)
- 이후: B→C 이행 판단, 인증 경로, 양산 HW
