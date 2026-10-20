import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}
