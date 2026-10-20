import { z } from 'zod';

const secret = z.string().min(32, '32자 이상');

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: secret,
  DATA_ENC_KEY: secret,
  LABEL_MASTER_KEY: secret,
  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** 앱 origin(CSRF Origin 검사, 쿠키 Secure 판단) */
  APP_ORIGIN: z.string().url().default('https://siot-cloud.fly.dev'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = ConfigSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`환경 변수 오류: ${issues}`);
  }
  return r.data;
}
