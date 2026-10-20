import { config } from './config.js';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;
const sinks = new Set();
function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
  else console.log(line);
  if (LEVELS[level] >= LEVELS.warn) for (const s of sinks) { try { s({ level, scope, msg: String(msg) }); } catch { /* ignore */ } }
}
/** WARN/ERROR 줄을 받는다(릴레이 evt log 용). 해제 함수를 돌려준다 */
export function onLog(sink) { sinks.add(sink); return () => sinks.delete(sink); }
export const logger = (scope) => ({
  debug: (m, e) => emit('debug', scope, m, e),
  info: (m, e) => emit('info', scope, m, e),
  warn: (m, e) => emit('warn', scope, m, e),
  error: (m, e) => emit('error', scope, m, e),
});
