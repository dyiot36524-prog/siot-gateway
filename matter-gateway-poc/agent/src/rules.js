// 로컬 자동화 엔진(클라우드 단절 시에도 동작). 규칙 포맷은 docs/neutral-model.md 참고.
//  파일 {version, rules}: version 0 = 손으로 쓴 로컬 규칙, ≥1 = 플랫폼 cfg.rules 로 받은 것
//  트리거: device(기본, type 생략 가능) = 상태 변경 / schedule = 30초 틱, tz 기준 "YYYY-MM-DD HH:MM" 키로 분당 1회
//  시계 게이트: RTC 없는 Pi 는 NTP 동기 전 시계가 틀리므로 clockSyncFile 이 생길 때까지 schedule 규칙을 보류(밀린 분은 건너뜀)
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('rules');
export const SCHEDULE_TICK_MS = 30_000;
const DEFAULT_TZ = 'Asia/Seoul';

export class RulesEngine {
  /** @param {{file?:string, now?:()=>Date, tickMs?:number, clockSyncFile?:string|null}} o */
  constructor(registry, execute, { file, now = () => new Date(), tickMs = SCHEDULE_TICK_MS, clockSyncFile = null } = {}) {
    this.registry = registry; this.execute = execute; this.file = file;
    this.now = now; this.tickMs = tickMs; this.clockSyncFile = clockSyncFile;
    this.rules = []; this.version = 0;
    this.lastFired = new Map();   // rule.id → 마지막 발동 분 키
    this.held = false; this.timer = null; this.saving = Promise.resolve();
    registry.on('state', (change) => this.onState(change).catch((e) => log.error('rule error', e.message)));
  }

  async load() {
    try { const j = JSON.parse(await readFile(this.file, 'utf8')); this.rules = Array.isArray(j.rules) ? j.rules : []; this.version = intOr0(j.version); }
    catch (e) { log.warn(`no rules loaded (${e.message})`); this.rules = []; this.version = 0; }
    log.info(`${this.rules.length} rules loaded (v${this.version})`);
  }

  /**
   * 규칙 전체 교체(멱등). 같거나 낮은 버전 재전송, 그리고 플랫폼이 아직 규칙을 안 보낸 상태(v0 + 빈 배열)는 무시한다.
   * @returns {Promise<boolean>} 적용 여부
   */
  async replace(rules, version = 0, persistTo = this.file) {
    const v = intOr0(version), list = Array.isArray(rules) ? rules : [];
    if (this.version > 0 && v <= this.version) { log.debug(`rules v${v} 무시(현재 v${this.version})`); return false; }
    if (v === 0 && list.length === 0) return false;
    // 메모리 먼저 바꿔 연달아 온 cfg 도 버전 가드를 통과하지 못하게 하고, 파일 쓰기는 순서대로
    this.rules = list; this.version = v;   // lastFired 는 id 로 유지 → 같은 분 재전송에 재발동하지 않음
    if (persistTo) await (this.saving = this.saving.catch(() => {}).then(() => atomicWrite(persistTo, { version: v, rules: list })));
    log.info(`rules installed v${v} (${list.length} rules)`);
    return true;
  }

  /** relay 'cfg' 프레임 → replace */
  onCfg(cfg) { return this.replace(cfg?.rules?.rules ?? [], cfg?.rules?.version ?? 0, this.file); }

  /** NTP 동기 여부. clockSyncFile 미설정(테스트·dev)이면 true */
  clockOk() { return !this.clockSyncFile || existsSync(this.clockSyncFile); }

  start() { if (this.timer) return; this.tick(); this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }

  /** schedule 규칙 검사(틱마다). 현재 분만 본다 → 보류·정지 중 지나간 분은 재생되지 않는다 */
  tick() {
    const sched = this.rules.filter((r) => r.enabled !== false && r.trigger?.type === 'schedule');
    if (!sched.length) return;
    if (!this.clockOk()) { if (!this.held) log.warn(`시계 미동기(${this.clockSyncFile} 없음) → schedule 규칙 보류`); this.held = true; return; }
    if (this.held) { log.info('시계 동기됨 → schedule 규칙 재개'); this.held = false; }
    const now = this.now();
    for (const rule of sched) {
      const t = rule.trigger;
      let p;
      try { p = localParts(now, t.tz ?? DEFAULT_TZ); } catch (e) { log.warn(`rule ${rule.id}: tz 오류 ${e.message}`); continue; }
      const [h, m] = String(t.at ?? '').split(':').map(Number);
      if (p.hour !== h || p.minute !== m) continue;
      if (Array.isArray(t.days) && t.days.length && !t.days.includes(p.weekday)) continue;
      const k = rule.id ?? rule;
      if (this.lastFired.get(k) === p.key) continue;
      this.lastFired.set(k, p.key);
      this.run(rule, { schedule: p.key }).catch((e) => log.error('rule error', e.message));
    }
  }

  matches(sel, change) {
    return (sel.deviceId == null || sel.deviceId === change.deviceId)
      && (sel.endpoint == null || sel.endpoint === change.endpoint)
      && sel.capability === change.capability
      && (sel.field == null || sel.field === change.field);
  }

  conditionOk(c) {
    const d = this.registry.get(c.deviceId);
    const v = d?.endpoints?.[c.endpoint ?? firstEp(d, c.capability)]?.capabilities?.[c.capability]?.[c.field];
    if ('equals' in c) return v === c.equals;
    if ('gt' in c) return typeof v === 'number' && v > c.gt;
    if ('lt' in c) return typeof v === 'number' && v < c.lt;
    return v != null;
  }

  async onState(change) {
    for (const rule of this.rules) {
      if (rule.enabled === false) continue;
      const t = rule.trigger ?? {};
      if ((t.type ?? 'device') !== 'device' || !this.matches(t, change)) continue;
      if ('changedTo' in t && !(change.value === t.changedTo && change.prev !== t.changedTo)) continue;
      if ('equals' in t && change.value !== t.equals) continue;
      await this.run(rule, change);
    }
  }

  /** 조건 확인 후 액션 순서대로 실행. mqtt 액션(옛 형식)은 무시 */
  async run(rule, ctx) {
    if ((rule.conditions ?? []).some((c) => !this.conditionOk(c))) return;
    log.info(`rule fired: ${rule.id}`, ctx);
    for (const a of rule.actions ?? []) {
      if (a.type === 'command') await this.execute(a);
      else if (a.type === 'delay') await new Promise((r) => setTimeout(r, a.ms));
    }
  }
}

const fmts = new Map();
/** tz 기준 {key:"YYYY-MM-DD HH:MM", hour, minute, weekday:"mon".."sun"} */
export function localParts(date, tz) {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }));
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { key: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`, hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday.toLowerCase() };
}

async function atomicWrite(file, body) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.rules.tmp.${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  await rename(tmp, file);
}

function firstEp(d, capability) {
  for (const e of Object.values(d?.endpoints ?? {})) if (e.capabilities[capability]) return e.id;
  return undefined;
}

function intOr0(x) { const n = Number(x); return Number.isInteger(n) && n >= 0 ? n : 0; }
