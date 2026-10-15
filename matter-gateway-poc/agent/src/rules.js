// 로컬 자동화 엔진(클라우드 단절 시에도 동작). 규칙 포맷은 docs/neutral-model.md 참고.
import { readFile, writeFile } from 'node:fs/promises';
import { logger } from './log.js';

const log = logger('rules');

export class RulesEngine {
  constructor(registry, execute, { file, publish }) {
    this.registry = registry; this.execute = execute; this.file = file; this.publish = publish;
    this.rules = [];
    registry.on('state', (change) => this.onState(change).catch((e) => log.error('rule error', e.message)));
  }

  async load() {
    try { this.rules = JSON.parse(await readFile(this.file, 'utf8')).rules ?? []; }
    catch (e) { log.warn(`no rules loaded (${e.message})`); this.rules = []; }
    log.info(`${this.rules.length} rules loaded`);
  }

  async replace(rules, persistTo) {
    this.rules = rules;
    if (persistTo) await writeFile(persistTo, JSON.stringify({ rules }, null, 2));
    log.info(`${rules.length} rules installed`);
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
      const t = rule.trigger;
      if (!this.matches(t, change)) continue;
      if ('changedTo' in t && !(change.value === t.changedTo && change.prev !== t.changedTo)) continue;
      if ('equals' in t && change.value !== t.equals) continue;
      if ((rule.conditions ?? []).some((c) => !this.conditionOk(c))) continue;
      log.info(`rule fired: ${rule.id}`, change);
      for (const a of rule.actions ?? []) {
        if (a.type === 'command') await this.execute(a);
        else if (a.type === 'mqtt') this.publish?.(a.topic, a.payload);
        else if (a.type === 'delay') await new Promise((r) => setTimeout(r, a.ms));
      }
    }
  }
}

function firstEp(d, capability) {
  for (const e of Object.values(d?.endpoints ?? {})) if (e.capabilities[capability]) return e.id;
  return undefined;
}
