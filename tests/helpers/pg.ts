// Real-PostgreSQL test helper. Each call creates an isolated, freshly migrated database.
//   TEST_DATABASE_URL  admin connection, e.g. postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable
//   REQUIRE_PG_TESTS=1 makes a missing database a FAILURE instead of a skip (set in CI).
import crypto from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../server/db/migrate.ts';
import { createPool, type Db } from '../../server/db/pool.ts';

export const PG_ADMIN_URL = process.env.TEST_DATABASE_URL || '';
if (!PG_ADMIN_URL && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but TEST_DATABASE_URL is not set: PostgreSQL tests must not be skipped here.');
}
/** `skip` value for node:test — a string reason when no database is configured (reported as SKIPPED, not passed). */
export const pgSkip = PG_ADMIN_URL ? false : 'TEST_DATABASE_URL not set — PostgreSQL tests skipped (NOT passed)';

export interface TestDb {
  url: string;
  name: string;
  pool: Db;
  drop: () => Promise<void>;
}

export function dbUrl(name: string) {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const name = `forge_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL.replace(/[?&]sslmode=disable/, '') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = dbUrl(name);
  const pool = createPool(url, { max: 5, applicationName: 'forge-test' });
  if (opts.migrate !== false) await migrate(pool);
  return {
    url,
    name,
    pool,
    drop: async () => {
      await pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: PG_ADMIN_URL.replace(/[?&]sslmode=disable/, '') });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
