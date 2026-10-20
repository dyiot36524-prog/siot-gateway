// npm run db:migrate — drizzle/ 의 SQL 마이그레이션을 DATABASE_URL 에 적용한다(빈 DB 에서 성공해야 함, B1).
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL 이 필요합니다');
  process.exit(1);
}
const { db, sql } = createDb(url, { max: 1 });
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  console.log('migrations applied');
} finally {
  await sql.end();
}
