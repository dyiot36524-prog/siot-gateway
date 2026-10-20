import { useSite } from '../state/site';

/** 세대 실시간 연결이 끊겼을 때만 보인다. 로그아웃하지 않고 다시 붙는다 */
export function StreamBanner() {
  const { stream } = useSite();
  if (stream !== 'reconnecting') return null;
  return (
    <div className="netbar" role="status">
      실시간 연결 끊김 · 다시 연결 중
    </div>
  );
}
