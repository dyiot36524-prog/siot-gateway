// 공개 ID 규칙(README): <prefix>_<ULID>. gatewayId 는 GW 가 정한 gw_<uuid>.
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export type IdPrefix = 'org' | 'usr' | 'site' | 'dev' | 'evt' | 'key' | 'wh' | 'whd' | 'pair' | 'aut';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const ID_PATTERNS = {
  org: new RegExp(`^org_${ULID}$`),
  usr: new RegExp(`^usr_${ULID}$`),
  site: new RegExp(`^site_${ULID}$`),
  dev: new RegExp(`^dev_${ULID}$`),
  evt: new RegExp(`^evt_${ULID}$`),
  wh: new RegExp(`^wh_${ULID}$`),
  pair: new RegExp(`^pair_${ULID}$`),
  aut: new RegExp(`^aut_${ULID}$`),
  gateway: /^gw_[0-9a-f-]{36}$/,
} as const;

/** gw_<uuid> → 앞 8 hex */
export function shortIdOf(gatewayId: string): string {
  return gatewayId.slice(3, 11);
}
