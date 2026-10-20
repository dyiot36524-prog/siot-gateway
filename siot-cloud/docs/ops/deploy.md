# 배포 (Fly.io, 앱 `siot-cloud`, nrt)

계획 §2 a(A1). 앱 1개에 API·릴레이·웹훅 워커·PWA. 설정은 `siot-cloud/fly.toml`, 이미지는 `siot-cloud/Dockerfile`.

## 최초 1회

```sh
cd siot-cloud
fly apps create siot-cloud --org <org>
# DB: 1안 Managed Postgres(권장, PITR) — docs/ops/backup.md
fly mpg create --name siot-db --region nrt          # 또는 콘솔에서 생성
fly secrets set DATABASE_URL='postgres://…' \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  DATA_ENC_KEY="$(openssl rand -base64 48)" \
  LABEL_MASTER_KEY="$(openssl rand -base64 48)" \
  ALERT_WEBHOOK_URL='https://hooks.slack.com/services/…'
```

`DATA_ENC_KEY`·`LABEL_MASTER_KEY` 는 비밀번호 관리자에 따로 보관한다. 잃으면 세대 키·웹훅 비밀 복호화와 라벨 claim 이 불가능하다.

## 배포

```sh
cd siot-cloud
fly deploy                      # release_command 가 마이그레이션(drizzle/*.sql) 후 머신 교체
curl -fsS https://siot-cloud.fly.dev/healthz     # {"ok":true,"db":"ok"}
curl -fsS https://siot-cloud.fly.dev/metrics | grep siot_
```

- 배포하면 GW 가 전부 재접속한다(최악 약 50초, 60초 SLO 안). 재기동 직후 모든 GW 는 offline 으로 시작하고, 배포 후 90초 동안 `gateway.offline` 웹훅·경보를 유예한다.
- 롤백: `fly releases` → `fly deploy --image <이전 이미지>`. 마이그레이션은 추가(additive)만이므로 이전 이미지가 새 스키마에서 돈다.

## 운영자 CLI

```sh
fly ssh console -C "sh -lc 'cd /app/apps/api && node --import tsx src/admin/cli.ts org:create --name 시옷플랫폼'"
# 로컬에서 운영 DB 로: fly proxy 5432 후 DATABASE_URL=… npm -w apps/api run admin -- …
npm -w apps/api run admin -- gateway:provision --id gw_<uuid> --pubkey <b64url> --org org_…   # LABEL_MASTER_KEY 필요
```

## 외부 업타임 모니터(C4)

- 대상 `https://siot-cloud.fly.dev/healthz`(DB ping, 실패 시 503), 간격 ≤5분, 지역 2곳 이상.
- 월간 가용률은 `docs/ops/uptime.md` 에 기록한다(≥99.5%, 중단 ≤216분).
