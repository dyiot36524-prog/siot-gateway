import { sql as dsql } from 'drizzle-orm';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
const app = await buildApp({
  config,
  db,
  pingDb: async () => {
    await db.execute(dsql`select 1`);
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
