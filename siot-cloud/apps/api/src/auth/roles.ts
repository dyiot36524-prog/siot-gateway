// 역할 권한(계획 §2 역할 권한, B4):
// - operator: 진단·로그·OTA·경보·조직/키 관리. 기기 제어 403, 이벤트 내용(기기 data) 불가 → 모든 세대 'diagnostics'.
// - installer: 자기 조직 세대. 인계 전(ownerUserId null) 'full', 인계 후 'diagnostics'(+ 세대 초기화).
// - resident: 소유 세대만 'full'.
import { forbidden } from '../http.js';
import type { SessionUser } from './session.js';

export type SiteAccess = 'full' | 'diagnostics' | 'none';

export interface SiteLike {
  orgId: string;
  ownerUserId: string | null;
}

export function siteAccess(user: SessionUser, site: SiteLike): SiteAccess {
  switch (user.role) {
    case 'operator':
      return 'diagnostics';
    case 'installer':
      if (!user.orgId || user.orgId !== site.orgId) return 'none';
      return site.ownerUserId ? 'diagnostics' : 'full';
    case 'resident':
      return site.ownerUserId === user.userId ? 'full' : 'none';
  }
}

/** 기기 목록·이벤트·이름 변경 등 data 를 보는 작업 */
export function requireFull(user: SessionUser, site: SiteLike): void {
  const a = siteAccess(user, site);
  if (a === 'full') return;
  if (a === 'diagnostics' && user.role === 'installer') throw forbidden('인계된 세대는 진단만 볼 수 있습니다', 'HANDED_OVER');
  throw forbidden();
}

/** 기기 제어. operator 는 항상 403 */
export function requireControl(user: SessionUser, site: SiteLike): void {
  if (user.role === 'operator') throw forbidden('운영자는 기기를 제어할 수 없습니다');
  requireFull(user, site);
}

/** 세대를 볼 수는 있는지(메타·진단) */
export function requireVisible(user: SessionUser, site: SiteLike): SiteAccess {
  const a = siteAccess(user, site);
  if (a === 'none') throw forbidden();
  return a;
}
