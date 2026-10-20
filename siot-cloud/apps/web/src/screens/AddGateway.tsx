// GW 바인딩: 라벨 QR 스캔 또는 `siot-<shortId>` + 라벨 코드 16자 수동 입력(계획 B2).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { type ClaimRequest, type Gateway, type Site } from '../api/client';
import { QrScanner } from '../components/QrScanner';
import { Screen } from '../components/ui';
import { formatLabelCode, normalizeLabelCode, normalizeShortId, parseGatewayDeepLink, parseGatewayQr } from '../lib/codes';
import { apiErrorText, claimErrorText, type Guidance } from '../lib/messages';
import { Link, useLocation } from '../lib/router';
import { useSession } from '../state/session';
import { useSite } from '../state/site';
import { StreamBanner } from './StreamBanner';

type Result = { kind: 'ok'; gateway: Gateway } | { kind: 'error'; guidance: Guidance; retry: ClaimRequest };

function useClaim(siteId: string) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const claim = async (req: ClaimRequest) => {
    setBusy(true);
    setResult(null);
    try {
      const gateway = await api.claimGateway(req);
      setResult({ kind: 'ok', gateway });
    } catch (e) {
      setResult({ kind: 'error', guidance: claimErrorText(e), retry: req });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, claim, reset: () => setResult(null), siteId };
}

export function AddGatewayScreen() {
  const { siteId, site, reload } = useSite();
  const c = useClaim(siteId);
  useEffect(() => {
    if (c.result?.kind === 'ok') void reload();
  }, [c.result, reload]);
  return (
    <Screen title="게이트웨이 추가" back={`/sites/${siteId}`} banner={<StreamBanner />}>
      {site && <p className="muted small">{site.name} 에 연결합니다.</p>}
      <ClaimPanel {...c} />
    </Screen>
  );
}

/** 폰 기본 카메라로 라벨 QR 을 찍어 `/g/<gatewayId>#<secret>` 로 들어온 경우: 세대를 고르고 바로 연결 */
export function GatewayLinkScreen({ gatewayId }: { gatewayId: string }) {
  const { api } = useSession();
  const { hash } = useLocation();
  const label = parseGatewayDeepLink(gatewayId, hash);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string>('');
  const c = useClaim(siteId);

  useEffect(() => {
    api
      .listSites({ limit: 100 })
      .then((p) => setSites(p.data.filter((s) => !s.handedOver)))
      .catch((e: unknown) => setError(apiErrorText(e)));
  }, [api]);

  return (
    <Screen title="게이트웨이 연결" back="/sites">
      {!label ? (
        <div className="notice notice--warn" role="alert">
          라벨 QR 정보가 올바르지 않습니다. 세대 화면의 "게이트웨이 추가"에서 다시 스캔하거나 수동으로 입력하세요.
        </div>
      ) : c.result || c.busy ? (
        <ClaimPanel {...c} />
      ) : (
        <div className="stack">
          <p>
            게이트웨이 <strong>siot-{label.gatewayId.slice(3, 11)}</strong> 를 어느 세대에 연결할까요?
          </p>
          {error && <p className="error">{error}</p>}
          {!sites && !error && <p className="muted">세대 불러오는 중…</p>}
          {sites?.length === 0 && (
            <p className="muted">
              설치 중인 세대가 없습니다. <Link to="/sites">세대를 먼저 만드세요.</Link>
            </p>
          )}
          <ul className="list">
            {sites?.map((s) => (
              <li key={s.siteId}>
                <button
                  type="button"
                  className="row row__btn"
                  onClick={() => {
                    setSiteId(s.siteId);
                    void c.claim({ gatewayId: label.gatewayId, claimSecret: label.claimSecret, siteId: s.siteId });
                  }}
                >
                  <div className="row__main">
                    <strong>{s.name}</strong>
                    {s.address && <span className="small muted">{s.address}</span>}
                  </div>
                  <span className="row__side small">연결 ›</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Screen>
  );
}

function ClaimPanel({
  busy,
  result,
  claim,
  reset,
  siteId,
}: ReturnType<typeof useClaim>) {
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  if (result?.kind === 'ok') {
    const g = result.gateway;
    return (
      <div className="stack">
        <div className="notice notice--ok" role="status">
          <strong>siot-{g.shortId} 연결됨</strong>
          <br />
          게이트웨이가 새 인증으로 다시 접속합니다(최대 1분). 세대 화면에서 "온라인"이 되면 페어링을 시작하세요.
        </div>
        <button type="button" className="btn btn--secondary btn--block" onClick={reset}>
          다른 게이트웨이 추가
        </button>
        <Link to={`/sites/${siteId}/pairing`} className="btn btn--primary btn--block">
          기기 페어링으로
        </Link>
        <Link to={`/sites/${siteId}`} className="btn btn--ghost btn--block">
          세대 화면으로
        </Link>
      </div>
    );
  }

  const onScan = (text: string) => {
    const label = parseGatewayQr(text);
    if (label) {
      setScanMsg(null);
      void claim({ gatewayId: label.gatewayId, claimSecret: label.claimSecret, siteId });
    } else if (/^MT:/i.test(text)) {
      setScanMsg('기기 QR 입니다. 게이트웨이 라벨의 QR 을 스캔하세요.');
    } else {
      setScanMsg('게이트웨이 라벨 QR 이 아닙니다.');
    }
  };

  return (
    <div className="stack">
      {busy && (
        <p className="muted" role="status">
          연결하는 중…
        </p>
      )}
      {result?.kind === 'error' && !busy && (
        <div className="notice notice--bad" role="alert">
          <strong>{result.guidance.title}</strong>
          <p>{result.guidance.hint}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void claim(result.retry)}>
            다시 시도
          </button>
        </div>
      )}
      <section className="card stack">
        <h2 className="section section--flush">라벨 QR 스캔</h2>
        <QrScanner onDetect={onScan} hint="게이트웨이 밑면 라벨의 QR 을 비추세요." />
        {scanMsg && (
          <p className="error" role="alert">
            {scanMsg}
          </p>
        )}
      </section>
      <ManualClaimForm busy={busy} onSubmit={(l) => void claim({ ...l, siteId })} />
    </div>
  );
}

function ManualClaimForm({ busy, onSubmit }: { busy: boolean; onSubmit(v: { shortId: string; claimSecret: string }): void }) {
  const [shortId, setShortId] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const sid = normalizeShortId(shortId);
  const secret = normalizeLabelCode(code);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!sid || !secret) return;
    onSubmit({ shortId: sid, claimSecret: secret });
  };

  return (
    <form className="card stack" onSubmit={submit} aria-label="수동 입력">
      <h2 className="section section--flush">수동 입력</h2>
      <label className="field">
        <span>게이트웨이 이름 (라벨의 siot- 뒤 8자리)</span>
        <div className="prefixed">
          <span>siot-</span>
          <input
            value={shortId}
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={13}
            placeholder="1a2b3c4d"
            onChange={(e) => {
              const v = e.target.value.toLowerCase().replace(/^siot-/, '');
              setShortId(v);
              if (normalizeShortId(v)) codeRef.current?.focus();
            }}
          />
        </div>
        {touched && !sid && <span className="error small">8자리(0-9, a-f)를 입력하세요.</span>}
      </label>
      <label className="field">
        <span>라벨 코드 16자</span>
        <input
          ref={codeRef}
          value={code}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="mono"
          onChange={(e) => setCode(formatLabelCode(e.target.value))}
        />
        {touched && !secret && <span className="error small">4-4-4-4 형식 16자를 입력하세요.</span>}
      </label>
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        연결
      </button>
    </form>
  );
}

