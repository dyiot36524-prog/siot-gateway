// GW 별 페어링 큐. 코드를 연속 스캔하면 대상 GW 큐에 넣고, 백엔드가 GW 마다 직렬·GW 끼리 병렬로 처리한다(계획 Step 3a).
// 이름·위치는 대기 중에 입력해 두면 완료 시 기기에 반영된다.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isGateway, type Gateway, type PairingSession } from '../api/client';
import { NameRoomForm } from '../components/NameRoom';
import { QrScanner } from '../components/QrScanner';
import { Badge, Empty, OnlineBadge, Screen } from '../components/ui';
import { maskCode, parseMatterCode } from '../lib/codes';
import { pairingErrorText, pairingStageText } from '../lib/messages';
import { Link } from '../lib/router';
import { isTerminal, useSite, type PairingEntry } from '../state/site';
import { StreamBanner } from './StreamBanner';

const AUTO = 'auto';

export function PairingScreen() {
  const { siteId, gateways, entries, sessions, enqueue } = useSite();
  const gws = gateways.filter(isGateway);
  const [target, setTarget] = useState<string>(AUTO);
  const [manual, setManual] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  // 렌더 전에 연속으로 들어온 코드(빠른 연속 스캔)도 분배·중복 판단에 넣는다
  const recent = useRef<Array<{ gatewayId: string; code: string }>>([]);
  useEffect(() => {
    recent.current = [];
  }, [entries]);
  const active = (gwId: string) =>
    entries.filter((e) => e.gatewayId === gwId && !(e.sessionId && isTerminal(sessions[e.sessionId]))).length +
    recent.current.filter((r) => r.gatewayId === gwId).length;
  const letter = (gwId: string) => String.fromCharCode(65 + Math.max(0, gws.findIndex((g) => g.gatewayId === gwId)));

  const pickGateway = (): Gateway | undefined => {
    if (target !== AUTO) return gws.find((g) => g.gatewayId === target);
    const candidates = gws.filter((g) => g.online);
    const pool = candidates.length ? candidates : gws;
    return pool.reduce<Gateway | undefined>((best, g) => (!best || active(g.gatewayId) < active(best.gatewayId) ? g : best), undefined);
  };

  const add = (raw: string): boolean => {
    const parsed = parseMatterCode(raw);
    if (!parsed) {
      setMsg({ tone: 'bad', text: '기기 코드가 아닙니다. 기기·상자의 Matter QR 또는 11/21자리 숫자 코드를 쓰세요.' });
      return false;
    }
    const dup =
      recent.current.find((r) => r.code === parsed.code) ??
      entries.find((e) => e.code === parsed.code && !(e.sessionId && sessions[e.sessionId]?.status === 'failed'));
    if (dup) {
      setMsg({ tone: 'bad', text: `이미 GW ${letter(dup.gatewayId)} 대기열에 있는 코드입니다 (${maskCode(parsed.code)}).` });
      return false;
    }
    const gw = pickGateway();
    if (!gw) {
      setMsg({ tone: 'bad', text: '게이트웨이를 먼저 추가하세요.' });
      return false;
    }
    recent.current.push({ gatewayId: gw.gatewayId, code: parsed.code });
    void enqueue(gw.gatewayId, parsed.code); // 요청 실패는 항목에 "요청 실패"로 남는다
    setMsg({ tone: 'ok', text: `GW ${letter(gw.gatewayId)} 대기열에 추가했습니다 (${maskCode(parsed.code)}).` });
    return true;
  };

  const onManual = (e: FormEvent) => {
    e.preventDefault();
    if (add(manual)) setManual('');
  };

  return (
    <Screen title="기기 페어링" back={`/sites/${siteId}`} banner={<StreamBanner />}>
      {gws.length === 0 ? (
        <Empty>
          게이트웨이가 없습니다. <Link to={`/sites/${siteId}/gateways/add`}>게이트웨이를 먼저 추가하세요.</Link>
        </Empty>
      ) : (
        <>
          <section className="card stack">
            <div className="field">
              <span>추가할 게이트웨이</span>
              <div className="chips" role="radiogroup" aria-label="대상 게이트웨이">
                <button type="button" role="radio" aria-checked={target === AUTO} className={target === AUTO ? 'chip chip--on' : 'chip'} onClick={() => setTarget(AUTO)}>
                  자동 (대기 적은 쪽)
                </button>
                {gws.map((g) => (
                  <button
                    key={g.gatewayId}
                    type="button"
                    role="radio"
                    aria-checked={target === g.gatewayId}
                    className={target === g.gatewayId ? 'chip chip--on' : 'chip'}
                    onClick={() => setTarget(g.gatewayId)}
                  >
                    GW {letter(g.gatewayId)}
                    {!g.online && ' (오프라인)'}
                  </button>
                ))}
              </div>
            </div>
            <QrScanner continuous onDetect={(t) => add(t)} hint="기기 QR 을 차례로 비추세요. 인식될 때마다 진동합니다." />
            <form className="inline-form" onSubmit={onManual} aria-label="코드 직접 입력">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="숫자 11/21자리 또는 MT:…"
                aria-label="기기 코드"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="mono"
              />
              <button type="submit" className="btn btn--primary">
                추가
              </button>
            </form>
            {msg && (
              <p className={msg.tone === 'ok' ? 'ok-text small' : 'error small'} role={msg.tone === 'bad' ? 'alert' : 'status'}>
                {msg.text}
              </p>
            )}
          </section>

          <div className="queues">
            {gws.map((g) => (
              <GatewayQueue key={g.gatewayId} gateway={g} letter={letter(g.gatewayId)} entries={entries.filter((e) => e.gatewayId === g.gatewayId)} />
            ))}
          </div>

          <Link to={`/sites/${siteId}/check`} className="btn btn--secondary btn--block">
            나가기 전 전체 점검
          </Link>
        </>
      )}
    </Screen>
  );
}

function GatewayQueue({ gateway, letter, entries }: { gateway: Gateway; letter: string; entries: PairingEntry[] }) {
  const { sessions } = useSite();
  const st = (e: PairingEntry) => (e.sessionId ? sessions[e.sessionId] : undefined);
  const running = entries.filter((e) => st(e)?.status === 'running').length;
  const waiting = entries.filter((e) => !st(e) || st(e)?.status === 'queued').length;
  const done = entries.filter((e) => st(e)?.status === 'done').length;
  const failed = entries.filter((e) => st(e)?.status === 'failed').length;
  return (
    <section className="queue" aria-label={`GW ${letter} 대기열`}>
      <header className="queue__head">
        <div>
          <strong>GW {letter}</strong> <span className="small muted">siot-{gateway.shortId}</span>
        </div>
        <OnlineBadge online={gateway.online} />
      </header>
      <p className="small muted">
        진행 {running} · 대기 {waiting} · 완료 {done}
        {failed > 0 && ` · 실패 ${failed}`}
      </p>
      {entries.length === 0 ? (
        <p className="small muted">아직 없음</p>
      ) : (
        <ol className="queue__list">
          {entries.map((e) => (
            <QueueItem key={e.localId} entry={e} session={st(e)} />
          ))}
        </ol>
      )}
    </section>
  );
}

function QueueItem({ entry, session }: { entry: PairingEntry; session: PairingSession | undefined }) {
  const { retry, dismiss, setEntryMeta, devices } = useSite();
  const device = session?.status === 'done' ? devices.find((d) => d.deviceId === session.deviceIds[0]) : undefined;
  const name = device?.name ?? entry.name;
  const room = device ? device.room : entry.room;
  const [editing, setEditing] = useState(false);
  const failed = session?.status === 'failed' || session?.status === 'cancelled';
  const done = session?.status === 'done';
  const guidance = failed ? pairingErrorText(session?.errorCode) : null;
  const tone = done ? 'ok' : failed || entry.enqueueError ? 'bad' : session?.status === 'running' ? 'warn' : 'muted';

  return (
    <li className={`item item--${tone}`}>
      <div className="item__head">
        <span className="mono small">{maskCode(entry.code)}</span>
        <span className="item__name">
          {name || '이름 없음'}
          {room ? ` · ${room}` : ''}
        </span>
        <Badge tone={tone}>{entry.enqueueError ? '요청 실패' : session ? pairingStageText(session) : '보내는 중'}</Badge>
      </div>
      {session?.status === 'running' && <div className="progress" aria-hidden><span /></div>}
      {entry.attempts > 1 && !failed && <p className="small muted">{entry.attempts}번째 시도</p>}
      {entry.enqueueError && (
        <div className="item__error" role="alert">
          <p>{entry.enqueueError}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void retry(entry.localId)}>
            다시 시도
          </button>
        </div>
      )}
      {guidance && (
        <div className="item__error" role="alert">
          <strong>{guidance.title}</strong>
          <p>{guidance.hint}</p>
          {session?.errorCode === 'UNKNOWN' && session.error && <p className="small muted mono">{session.error}</p>}
          <div className="btnrow">
            <button type="button" className="btn btn--primary" onClick={() => void retry(entry.localId)}>
              다시 시도
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => dismiss(entry.localId)}>
              목록에서 지우기
            </button>
          </div>
        </div>
      )}
      {!failed && (
        <button type="button" className="linkbtn" onClick={() => setEditing(!editing)} aria-expanded={editing}>
          {editing ? '닫기' : done ? '이름·위치 바꾸기' : '이름·위치 미리 입력'}
        </button>
      )}
      {editing && (
        <NameRoomForm
          compact
          initialName={name}
          initialRoom={room}
          saveLabel={done ? '저장' : '완료되면 적용'}
          onSave={(v) => setEntryMeta(entry.localId, v)}
        />
      )}
    </li>
  );
}
