# 복원 리허설 (분기 1회, 목표 RTO ≤30분)

계획 Step 1-9 완료 조건: 리허설 1회, RTO ≤30분. 결과는 아래 기록 표에 남긴다.

## 절차 (1안 Managed Postgres)

1. **시각 기록** T0. 리허설용 데이터를 남긴다: `npm -w apps/api run admin -- org:create --name drill-<날짜>` → `orgId` 메모. 그 시각 T1.
2. 콘솔 *Backups → Restore* 에서 T1 + 1분 시점으로 **새 클러스터** `siot-db-drill` 복원(운영 DB 는 건드리지 않음).
3. 스테이징 앱(`siot-cloud-drill`, 같은 이미지)의 `DATABASE_URL` 을 복원본으로 설정 후 `fly deploy -a siot-cloud-drill`.
4. 확인
   - `curl https://siot-cloud-drill.fly.dev/healthz` → 200
   - `select org_id from organizations where name like 'drill-%'` 에 1의 orgId 가 있다(RPO 확인)
   - `select count(*) from gateways, sites, site_keys, api_keys` 가 운영과 같은 자릿수
   - `/v1/sites` 를 운영 키로 호출 → 200(키 해시 복원 확인)
5. **시각 기록** T2. RTO = T2 − T0(복원 요청부터 healthz 200 까지).
6. 정리: `siot-db-drill`, `siot-cloud-drill` 삭제.

## 절차 (2안 wal-g)

1~1단계 동일. 새 볼륨의 Postgres 머신에서:

```sh
wal-g backup-fetch $PGDATA LATEST
cat > $PGDATA/recovery.signal </dev/null
echo "restore_command = 'wal-g wal-fetch %f %p'" >> $PGDATA/postgresql.auto.conf
echo "recovery_target_time = '<T1+1분 ISO>'" >> $PGDATA/postgresql.auto.conf
pg_ctl start   # 복구 완료 후 promote
```

이후 3~6 동일.

## 실제 전환(장애 시)

`fly secrets set DATABASE_URL=<복원본>` → 머신이 재기동되며 GW 가 재접속하고 snapshot 으로 캐시를 다시 채운다.

## 기록

| 날짜 | 방식 | 복원 시점 | RPO 확인 | RTO | 수행자 | 비고 |
|---|---|---|---|---|---|---|
| (미실시) | | | | | | 로컬에 flyctl 이 없어 Step 1 에서는 절차 문서만 작성 |
