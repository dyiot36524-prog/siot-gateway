// 나가기 전 "전체 정상" 체커(계획 E3): 모든 GW online, 모든 기기 online, 인계 완료일 때만 녹색.
import { useEffect } from 'react';
import { isGateway } from '../api/client';
import { Screen } from '../components/ui';
import { Link } from '../lib/router';
import { isTerminal, useSite } from '../state/site';
import { StreamBanner } from './StreamBanner';

interface Check {
  key: string;
  ok: boolean;
  label: string;
  /** false 면 참고 항목(녹색 판정에 넣지 않음) */
  blocking?: boolean;
}

export function CheckerScreen() {
  const { siteId, site, gateways, devices, devicesHidden, stream, entries, sessions, reload } = useSite();

  // 실시간 연결이 없으면 15초마다 다시 읽는다(GW 오프라인을 30초 안에 반영)
  useEffect(() => {
    if (stream === 'open') return;
    const t = setInterval(() => void reload(), 15_000);
    return () => clearInterval(t);
  }, [stream, reload]);

  const checks: Check[] = [];
  // 인계 후 기사는 이벤트 구독이 403 이라 15초 폴링으로 본다
  const polled = stream === 'denied' && !!site?.handedOver;
  checks.push({
    key: 'stream',
    ok: stream === 'open' || polled,
    label: stream === 'open' ? '실시간 연결 정상' : polled ? '인계 후 진단 모드 (15초마다 갱신)' : '실시간 연결 끊김 · 상태를 확인할 수 없음',
  });
  checks.push({ key: 'gw-any', ok: gateways.length > 0, label: gateways.length > 0 ? `게이트웨이 ${gateways.length}대` : '게이트웨이 없음' });
  gateways.forEach((g, i) => {
    const name = `GW ${String.fromCharCode(65 + i)}${isGateway(g) ? ` (siot-${g.shortId})` : ''}`;
    checks.push({ key: `gw-${i}`, ok: g.online, label: g.online ? `${name} 온라인` : `${name} 오프라인` });
  });
  if (devicesHidden) {
    // 인계 후에는 기기 목록이 403 이라 GW 진단의 deviceCount 로 본다
    const n = gateways.reduce((a, g) => a + g.deviceCount, 0);
    checks.push({ key: 'dev-any', ok: n > 0, label: n > 0 ? `기기 ${n}개 (인계 후 개별 상태는 거주자만 봄)` : '기기 없음' });
  } else {
    checks.push({ key: 'dev-any', ok: devices.length > 0, label: devices.length > 0 ? `기기 ${devices.length}개` : '기기 없음' });
  }
  for (const d of devices) {
    checks.push({ key: d.deviceId, ok: d.online, label: `${d.name}${d.room ? ` (${d.room})` : ''} ${d.online ? '온라인' : '오프라인'}` });
  }
  const pendingPairing = entries.filter((e) => !e.sessionId || !isTerminal(sessions[e.sessionId])).length;
  const failedPairing = entries.filter((e) => e.sessionId && sessions[e.sessionId]?.status === 'failed').length;
  if (pendingPairing || failedPairing) {
    checks.push({
      key: 'pairing',
      ok: false,
      blocking: false,
      label: `페어링 ${pendingPairing ? `진행·대기 ${pendingPairing}개` : ''}${pendingPairing && failedPairing ? ' · ' : ''}${failedPairing ? `실패 ${failedPairing}개` : ''}`,
    });
  }
  const handedOver = !!site?.handedOver;
  checks.push({ key: 'handover', ok: handedOver, label: handedOver ? '인계 완료' : '인계 미완료' });

  const allOk = checks.every((c) => c.ok || c.blocking === false);
  const bad = checks.filter((c) => !c.ok && c.blocking !== false);

  return (
    <Screen title="전체 점검" back={`/sites/${siteId}`} banner={<StreamBanner />}>
      <div className={allOk ? 'verdict verdict--ok' : 'verdict verdict--bad'} role="status" aria-live="polite">
        <strong>{allOk ? '전체 정상' : '확인 필요'}</strong>
        <span>{allOk ? '나가셔도 됩니다.' : bad.map((c) => c.label).join(', ')}</span>
      </div>

      <ul className="checks">
        {checks.map((c) => (
          <li key={c.key} className={c.ok ? 'check check--ok' : c.blocking === false ? 'check check--warn' : 'check check--bad'}>
            <span className="check__icon" aria-hidden>
              {c.ok ? '✓' : c.blocking === false ? '!' : '✕'}
            </span>
            <span>{c.label}</span>
          </li>
        ))}
      </ul>

      {!handedOver && (
        <div className="notice">
          인계(거주자 초대·인계 카드)는 다음 업데이트에서 이 화면에 추가됩니다. 그 전까지는 관리자에게 인계를 요청하세요.
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn btn--secondary btn--block" onClick={() => void reload()}>
          다시 확인
        </button>
        {(pendingPairing > 0 || failedPairing > 0) && (
          <Link to={`/sites/${siteId}/pairing`} className="btn btn--ghost btn--block">
            페어링 화면으로
          </Link>
        )}
      </div>
    </Screen>
  );
}
