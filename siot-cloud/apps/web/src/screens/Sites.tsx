import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Site } from '../api/client';
import { Badge, Empty, Screen } from '../components/ui';
import { apiErrorText } from '../lib/messages';
import { Link, navigate } from '../lib/router';
import { useSession } from '../state/session';

export function SitesScreen() {
  const { api, setOffline } = useSession();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all: Site[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.listSites({ cursor, limit: 100 });
          all.push(...page.data);
          cursor = page.nextCursor ?? undefined;
        } while (cursor && all.length < 500);
        if (alive) setSites(all);
      } catch (e) {
        if (!alive) return;
        if (!(e instanceof ApiError)) setOffline(true);
        setError(apiErrorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, setOffline]);

  const inProgress = sites?.filter((s) => !s.handedOver) ?? [];
  const done = sites?.filter((s) => s.handedOver) ?? [];

  return (
    <Screen title="세대">
      {!creating ? (
        <button type="button" className="btn btn--primary btn--block" onClick={() => setCreating(true)}>
          + 새 세대 만들기
        </button>
      ) : (
        <CreateSiteForm onCancel={() => setCreating(false)} />
      )}

      {error && !sites && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!sites && !error && <p className="muted">불러오는 중…</p>}

      {sites && (
        <>
          <h2 className="section">설치 중 ({inProgress.length})</h2>
          {inProgress.length === 0 ? (
            <Empty>설치 중인 세대가 없습니다. 위에서 새 세대를 만드세요.</Empty>
          ) : (
            <ul className="list">
              {inProgress.map((s) => (
                <SiteRow key={s.siteId} site={s} />
              ))}
            </ul>
          )}
          {done.length > 0 && (
            <>
              <h2 className="section">인계 완료 ({done.length})</h2>
              <ul className="list">
                {done.map((s) => (
                  <SiteRow key={s.siteId} site={s} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Screen>
  );
}

function SiteRow({ site }: { site: Site }) {
  return (
    <li>
      <Link to={`/sites/${site.siteId}`} className="row">
        <div className="row__main">
          <strong>{site.name}</strong>
          {site.address && <span className="muted small">{site.address}</span>}
        </div>
        <div className="row__side">
          <span className="small muted">GW {site.gatewayCount}</span>
          {site.handedOver ? <Badge tone="muted">인계됨</Badge> : <Badge tone="warn">설치 중</Badge>}
        </div>
      </Link>
    </li>
  );
}

function CreateSiteForm({ onCancel }: { onCancel(): void }) {
  const { api } = useSession();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const site = await api.createSite({ name: name.trim(), address: address.trim() || null });
      navigate(`/sites/${site.siteId}`);
    } catch (err) {
      setError(apiErrorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={onSubmit} aria-label="새 세대">
      <label className="field">
        <span>세대 이름</span>
        <input required maxLength={100} placeholder="예: 101동 1203호" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>주소 (선택)</span>
        <input maxLength={300} placeholder="예: 서울 강남구 …" value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="btnrow">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
          {busy ? '만드는 중…' : '만들기'}
        </button>
      </div>
    </form>
  );
}
