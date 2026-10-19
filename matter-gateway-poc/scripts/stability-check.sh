#!/bin/bash
# 24시간 안정성 합격 기준 점검 — Pi 에서 실행(또는 ssh gslt@<pi> bash -s < scripts/stability-check.sh).
# 사용: stability-check.sh [SINCE]   (SINCE 는 docker logs --since 형식, 기본 24h)
# 집계: 에이전트 재접속/오류, matterjs-server 세션·구독 오류, 컨테이너 재시작, 기기 online/lastUpdated/battery,
#       BLE supervision_timeout, OTBR 상태. 종료 코드 0 = 이상 없음, 1 = 경고 항목 있음.
set -u
SINCE="${1:-24h}"
DIR="${MATTER_GATEWAY_DIR:-/opt/matter-gateway}"
warn=0
strip() { sed 's/\x1b\[[0-9;]*m//g'; }
say() { printf '%s\n' "$*"; }
flag() { warn=1; say "  !! $*"; }

say "== stability-check since=$SINCE  now=$(date -Is)  uptime:$(uptime -p 2>/dev/null)"

say "== containers"
(cd "$DIR" && docker compose ps --format 'table {{.Name}}\t{{.Status}}') 2>/dev/null || docker ps --format 'table {{.Names}}\t{{.Status}}'
for c in gateway-agent matterjs-server otbr; do
  rc=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo '?')
  st=$(docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null || echo '?')
  say "  $c restarts=$rc startedAt=$st"
  [ "$rc" != "0" ] && [ "$rc" != "?" ] && flag "$c 가 $rc 회 재시작됨"
done

say "== gateway-agent ($SINCE)"
AL=$(docker logs --since "$SINCE" gateway-agent 2>&1 | strip)
a_total=$(printf '%s\n' "$AL" | grep -c .)
a_sync=$(printf '%s\n' "$AL" | grep -c 'synced ')
a_reconn=$(printf '%s\n' "$AL" | grep -c 'disconnected, reconnecting')
a_notready=$(printf '%s\n' "$AL" | grep -c 'matter backend not ready')
a_err=$(printf '%s\n' "$AL" | grep -cE ' ERROR ')
a_warn=$(printf '%s\n' "$AL" | grep -cE ' WARN ')
say "  lines=$a_total synced=$a_sync reconnects=$a_reconn backend_not_ready=$a_notready error=$a_err warn=$a_warn"
printf '%s\n' "$AL" | grep -E 'synced |disconnected|not ready| ERROR | WARN ' | tail -20 | sed 's/^/  /'
[ "$a_reconn" -gt 0 ] && flag "에이전트가 matterjs-server 에 $a_reconn 회 재접속"
[ "$a_err" -gt 0 ] && flag "에이전트 ERROR $a_err 건"

say "== matterjs-server ($SINCE)"
ML=$(docker logs --since "$SINCE" matterjs-server 2>&1 | strip)
m_total=$(printf '%s\n' "$ML" | grep -c .)
m_err=$(printf '%s\n' "$ML" | grep -cE ' (ERROR|FATAL) ')
m_warn=$(printf '%s\n' "$ML" | grep -cE ' WARN ')
m_subfail=$(printf '%s\n' "$ML" | grep -ciE 'subscription (failed|timed out|lost|expired)|resubscri|re-subscri')
m_offline=$(printf '%s\n' "$ML" | grep -ciE 'is offline|went offline|node .* unreachable|Reconnect(ing)? to node|Connection lost')
m_case=$(printf '%s\n' "$ML" | grep -cE 'CaseClient .* New session')
m_ws=$(printf '%s\n' "$ML" | grep -c 'WebSocket connection closed')
m_timeout=$(printf '%s\n' "$ML" | grep -ciE 'timeout|timed out' )
say "  lines=$m_total error=$m_err warn=$m_warn subscription_issues=$m_subfail offline/reconnect=$m_offline new_CASE_sessions=$m_case ws_closed=$m_ws timeout_mentions=$m_timeout"
printf '%s\n' "$ML" | grep -E ' (ERROR|FATAL|WARN) ' | grep -vE 'DclCertifi' | tail -20 | sed 's/^/  /'
printf '%s\n' "$ML" | grep -iE 'is offline|went offline|unreachable|Reconnect(ing)? to node|Connection lost|subscription (failed|timed out|lost|expired)|resubscri' | tail -20 | sed 's/^/  /'
[ "$m_err" -gt 0 ] && flag "matterjs-server ERROR $m_err 건"
[ "$m_subfail" -gt 0 ] && flag "구독 문제 $m_subfail 건"
[ "$m_offline" -gt 0 ] && flag "노드 오프라인/재접속 $m_offline 건"

say "== devices (http://127.0.0.1:3000/api/devices)"
DJ=$(curl -s -m 5 http://127.0.0.1:3000/api/devices)
if [ -z "$DJ" ]; then flag "에이전트 API 응답 없음"; else
  printf '%s' "$DJ" | python3 -c '
import json,sys,datetime
j=json.load(sys.stdin); now=datetime.datetime.now(datetime.timezone.utc); bad=0
for d in j.get("devices",[]):
    lu=d.get("lastUpdated"); age="?"
    if lu:
        t=datetime.datetime.fromisoformat(lu.replace("Z","+00:00")); age="%.0fm"%((now-t).total_seconds()/60)
    print("  %-12s %-14s online=%-5s lastUpdated=%s (%s ago) data=%s"%(d["id"],d["deviceType"],d.get("online"),lu,age,json.dumps(d.get("data"),ensure_ascii=False)))
    if not d.get("online"): bad+=1
sys.exit(1 if bad else 0)' || flag "offline 기기 있음"
fi

say "== BLE supervision_timeout (기대 200)"
if st=$(sudo -n cat /sys/kernel/debug/bluetooth/hci0/supervision_timeout 2>/dev/null); then
  say "  $st"; [ "$st" != "200" ] && flag "supervision_timeout=$st (ble-conn-params.service 확인)"
else say "  (sudo 불가 — 수동 확인: sudo cat /sys/kernel/debug/bluetooth/hci0/supervision_timeout)"; fi
systemctl is-active ble-conn-params.service >/dev/null 2>&1 && say "  ble-conn-params.service: $(systemctl is-active ble-conn-params.service) ($(systemctl show -p Result --value ble-conn-params.service))" || say "  ble-conn-params.service: $(systemctl is-active ble-conn-params.service 2>&1) ($(systemctl show -p Result --value ble-conn-params.service 2>/dev/null))"

say "== OTBR"
ots=$(docker exec otbr ot-ctl state 2>/dev/null | head -1 | tr -d "\r "); say "  state=$ots"
[ "$ots" != "leader" ] && flag "OTBR state=$ots (leader 기대)"
docker exec otbr ot-ctl neighbor table 2>/dev/null | grep -E '^\|' | sed 's/^/  /'

say "== result: $([ $warn -eq 0 ] && echo OK || echo WARN)"
exit $warn
