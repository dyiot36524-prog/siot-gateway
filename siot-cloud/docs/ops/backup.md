# DB 백업 (RPO ≤5분, RTO ≤30분)

계획 §2 a. 보호 대상은 조직·세대·바인딩·키(organizations, users, sites, site_keys, gateways, api_keys, webhooks, audit_log).
기기 상태 캐시는 GW snapshot 으로 다시 만들어지므로 손실돼도 된다. 일 1회 볼륨 스냅샷만으로는 RPO 24h 라 쓰지 않는다.

## 1안: Fly Managed Postgres (권장)

- nrt(또는 가장 가까운 지역)에 만든다. 연속 백업(PITR)이 기본으로 켜져 있다 — 콘솔 *Backups* 에서 보존 기간 7일 이상 확인.
- RPO: WAL 연속 보관으로 ≤5분. RTO: 시점 복원으로 새 클러스터 생성(보통 10~20분) + `DATABASE_URL` 교체.
- 점검: 매월 1회 콘솔에서 마지막 복원 가능 시각이 5분 이내인지 본다.

## 2안: Fly Postgres(앱형) + wal-g → Tigris

Managed 를 쓸 수 없을 때.

```sh
fly storage create --name siot-wal          # Tigris 버킷, AWS_* 자격 증명이 secrets 로 붙는다
fly secrets set -a siot-db \
  WALG_S3_PREFIX=s3://siot-wal/siot-db AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev \
  WALG_COMPRESSION_METHOD=brotli
# postgresql.conf (fly ssh console -a siot-db)
archive_mode = on
archive_command = 'wal-g wal-push %p'
archive_timeout = 60            # 1분마다 세그먼트 강제 전환 → RPO ≤5분
# 기본 백업: 매일 1회
wal-g backup-push $PGDATA       # cron 또는 Fly Machines schedule=daily
wal-g delete retain FULL 7 --confirm
```

- 점검: `wal-g backup-list`, `wal-g wal-show` 의 마지막 세그먼트 시각이 5분 이내.

## 경보

- 백업 실패·WAL 지연(>5분)은 `ALERT_WEBHOOK_URL` 로 보낸다(2안은 cron 스크립트에서 curl).
