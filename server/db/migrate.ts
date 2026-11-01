// Schema migration runner (ADR-002).
//  * Files: server/db/migrations/NNNN_name.sql, applied in order, each in its own transaction.
//  * schema_migrations records version + SHA-256; an applied file that was later edited is a hard error
//    (migrations are append-only: fix forward with a new file).
//  * A transaction-scoped advisory lock makes concurrent instance start-ups safe: one applies, the rest wait.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOCKS, withTx, type Db } from './pool.ts';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return { version: Number(f.slice(0, 4)), name: f, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<{ applied: string[]; current: number }> {
  const files = loadMigrations(dir);
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCKS.migrations]);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await tx.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const r of rows) {
      const f = files.find((x) => x.version === r.version);
      if (!f) throw new Error(`database has migration ${r.name} that is not in this build (newer schema?); refusing to run`);
      if (f.checksum !== r.checksum) throw new Error(`migration ${r.name} was modified after it was applied; add a new migration instead`);
    }
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.version)) continue;
      // Savepoint per file so the error names the failing migration; the outer tx keeps all-or-nothing.
      await tx.query('SAVEPOINT m');
      try {
        await tx.query(f.sql);
      } catch (err: any) {
        throw new Error(`migration ${f.name} failed: ${err?.message || err}`);
      }
      await tx.query('RELEASE SAVEPOINT m');
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [f.version, f.name, f.checksum]);
      applied.push(f.name);
    }
    return { applied, current: files.length ? files[files.length - 1].version : 0 };
  });
}
