import { useState } from 'react';
import { isGateway, type Device } from '../api/client';
import { NameRoomForm } from '../components/NameRoom';
import { Badge, Empty, OnlineBadge, Screen } from '../components/ui';
import { Link } from '../lib/router';
import { gatewayLabel, useSite } from '../state/site';
import { StreamBanner } from './StreamBanner';

const TYPE_LABEL: Record<string, string> = {
  PLUG: '플러그',
  SWITCH: '스위치',
  LIGHT: '조명',
  SENSOR: '센서',
  BINARY_SENSOR: '감지 센서',
  COVER: '커튼·블라인드',
  CLIMATE: '냉난방',
  FAN: '팬',
  LOCK: '도어락',
  WEATHER: '날씨',
  UNKNOWN: '기기',
};

export function SiteDetailScreen() {
  const { site, siteId, gateways, devices, loading, loadError } = useSite();
  const gwOffline = gateways.filter((g) => !g.online).length;
  const devOffline = devices.filter((d) => !d.online).length;

  return (
    <Screen title={site?.name ?? '세대'} back="/sites" banner={<StreamBanner />}>
      {loading && !site && <p className="muted">불러오는 중…</p>}
      {loadError && !site && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {site && (
        <>
          {site.address && <p className="muted small">{site.address}</p>}
          {site.handedOver && (
            <div className="notice">인계된 세대입니다. 진단 정보만 볼 수 있습니다.</div>
          )}

          <div className="summary">
            <div>
              <span className="summary__n">{gateways.length}</span>
              <span className="small muted">게이트웨이</span>
              {gwOffline > 0 && <Badge tone="bad">{gwOffline} 오프라인</Badge>}
            </div>
            <div>
              <span className="summary__n">{devices.length}</span>
              <span className="small muted">기기</span>
              {devOffline > 0 && <Badge tone="bad">{devOffline} 오프라인</Badge>}
            </div>
          </div>

          {!site.handedOver && (
            <div className="actions">
              <Link to={`/sites/${siteId}/gateways/add`} className="btn btn--secondary btn--block">
                게이트웨이 추가
              </Link>
              <Link
                to={`/sites/${siteId}/pairing`}
                className={gateways.length ? 'btn btn--primary btn--block' : 'btn btn--primary btn--block btn--disabled'}
                aria-disabled={!gateways.length}
                onClick={(e) => {
                  if (!gateways.length) e.preventDefault();
                }}
              >
                기기 페어링
              </Link>
              <Link to={`/sites/${siteId}/check`} className="btn btn--secondary btn--block">
                나가기 전 전체 점검
              </Link>
            </div>
          )}

          <h2 className="section">게이트웨이</h2>
          {gateways.length === 0 ? (
            <Empty>아직 게이트웨이가 없습니다. 전원을 켜고 "게이트웨이 추가"로 라벨 QR 을 스캔하세요.</Empty>
          ) : (
            <ul className="list">
              {gateways.map((g, i) => (
                <li key={isGateway(g) ? g.gatewayId : i} className="row">
                  <div className="row__main">
                    <strong>GW {String.fromCharCode(65 + i)}</strong>
                    <span className="small muted">
                      {isGateway(g) ? `siot-${g.shortId} · ` : ''}기기 {g.deviceCount}
                      {g.agentVersion ? ` · v${g.agentVersion}` : ''}
                    </span>
                    {!g.online && <span className="small muted">마지막 연결 {formatSeen(g.lastSeen)}</span>}
                  </div>
                  <div className="row__side">
                    <OnlineBadge online={g.online} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 className="section">기기</h2>
          {devices.length === 0 ? (
            <Empty>{site.handedOver ? '인계 후에는 기기 목록을 볼 수 없습니다.' : '아직 기기가 없습니다. "기기 페어링"에서 기기 QR 을 스캔하세요.'}</Empty>
          ) : (
            <ul className="list">
              {devices.map((d) => (
                <DeviceRow key={d.deviceId} device={d} gwLabel={gatewayLabel(gateways, d.gatewayId)} editable={!site.handedOver} />
              ))}
            </ul>
          )}
        </>
      )}
    </Screen>
  );
}

function DeviceRow({ device, gwLabel, editable }: { device: Device; gwLabel: string; editable: boolean }) {
  const { saveDevice } = useSite();
  const [open, setOpen] = useState(false);
  return (
    <li className="row row--col">
      <button type="button" className="row__btn" onClick={() => editable && setOpen(!open)} aria-expanded={open}>
        <div className="row__main">
          <strong>{device.name}</strong>
          <span className="small muted">
            {TYPE_LABEL[device.deviceType] ?? '기기'} · {device.room ?? '위치 없음'} · {gwLabel}
          </span>
        </div>
        <div className="row__side">
          <OnlineBadge online={device.online} />
        </div>
      </button>
      {open && (
        <NameRoomForm
          initialName={device.name}
          initialRoom={device.room}
          onSave={async (v) => {
            await saveDevice(device.deviceId, { ...(v.name ? { name: v.name } : {}), room: v.room });
          }}
        />
      )}
    </li>
  );
}

function formatSeen(iso: string | null): string {
  if (!iso) return '없음';
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.round(sec / 60)}분 전`;
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
