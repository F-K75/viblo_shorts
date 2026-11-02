// Schema migration runner (ADR-002, R-14).
//  * Files: server/db/migrations/NNNN_name.sql, applied in order. ALL pending files run in ONE transaction:
//    a failure (error, timeout, lock timeout) rolls everything back, leaving schema and schema_migrations exactly
//    as before, so a fixed re-run always recovers. A partially applied migration is impossible.
//  * schema_migrations records version + SHA-256; an applied file that was later edited is a hard error
//    (migrations are append-only: fix forward with a new file).
//  * A transaction-scoped advisory lock makes concurrent instance start-ups safe: one applies, the rest wait.
//  * Timeouts are migration-specific (R-14): the request pool's 10 s statement timeout (and node-postgres'
//    client-side query timeout) must not cancel a long DDL/backfill midway. Lock waits on tables are bounded
//    separately, so DDL cannot block live traffic indefinitely.
//  * Statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY, VACUUM, ...) are rejected up front,
//    before anything is applied; run those as a separate, manual release step.
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
  /** Declared with a `-- forge:backward-compatible` line: the previous release can run against this schema. */
  backwardCompatible: boolean;
}

export interface MigrateOptions {
  /** Max duration of any single migration statement (default MIGRATION_STATEMENT_TIMEOUT_MS or 30 min). */
  statementTimeoutMs?: number;
  /** Max wait for a table lock taken by DDL (default MIGRATION_LOCK_TIMEOUT_MS or 60 s). */
  lockTimeoutMs?: number;
}

const NON_TRANSACTIONAL = [
  /\bCONCURRENTLY\b/i,
  /^\s*VACUUM\b/im,
  /^\s*CREATE\s+DATABASE\b/im,
  /^\s*DROP\s+DATABASE\b/im,
  /^\s*ALTER\s+SYSTEM\b/im,
  /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im,
];

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const BACKWARD_COMPATIBLE = /^--\s*forge:backward-compatible\s*$/m;
const DIRECTIVE_LINE = /^\s*--\s*forge\s*:/im;

/**
 * F5/F6: migration metadata is validated, never trusted blindly.
 *  * The only directive is `-- forge:backward-compatible`; any other (or misspelt) `-- forge:` line is an error.
 *  * A migration carrying the marker may contain ONLY expand-only statements, i.e. statements the previous
 *    release cannot be broken by (it writes with explicit column lists and never touches tables it does not know):
 *      CREATE TABLE / CREATE [UNIQUE] INDEX / ADD CONSTRAINT on a table created in the same file;
 *      CREATE INDEX (non-unique) on an existing table; ALTER TABLE … ADD COLUMN that is nullable or has a DEFAULT;
 *      COMMENT ON …; UPDATE (backfill of new columns).
 *    Everything else (DROP, RENAME, type changes, SET NOT NULL, new constraints or unique indexes on existing
 *    tables, DELETE/TRUNCATE, triggers, functions, …) is rejected: such a change needs expand → code → contract.
 */
function validateMetadata(name: string, sql: string): boolean {
  for (const line of sql.split('\n')) {
    if (DIRECTIVE_LINE.test(line) && !/^--\s*forge:backward-compatible\s*$/.test(line.trim())) {
      throw new Error(`${name}: unknown migration directive "${line.trim().slice(0, 60)}" (the only directive is "-- forge:backward-compatible"); nothing was applied`);
    }
  }
  if (!BACKWARD_COMPATIBLE.test(sql)) return false;
  const statements = sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const created = new Set<string>();
  const ident = (x: string) => x.replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
  for (const st of statements) {
    let m: RegExpExecArray | null;
    let ok = false;
    if ((m = /^CREATE TABLE (?:IF NOT EXISTS )?([\w."]+)/i.exec(st))) {
      created.add(ident(m[1]));
      ok = true;
    } else if ((m = /^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?[\w"]+ ON (?:ONLY )?([\w."]+)/i.exec(st))) {
      ok = !m[1] || created.has(ident(m[2]));
    } else if ((m = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) (.*)$/i.exec(st))) {
      const table = ident(m[1]);
      const actions = m[2].split(/,(?![^()]*\))/).map((a) => a.trim());
      ok = actions.every((a) => {
        if (created.has(table)) return /^(ADD|ALTER COLUMN [\w"]+ SET DEFAULT)\b/i.test(a) && !/\b(DROP|RENAME)\b/i.test(a);
        if (!/^ADD COLUMN /i.test(a)) return false;
        if (/\b(PRIMARY KEY|UNIQUE|REFERENCES|CHECK|GENERATED|CONSTRAINT)\b/i.test(a)) return false;
        return !/\bNOT NULL\b/i.test(a) || /\bDEFAULT\b/i.test(a);
      });
    } else if (/^COMMENT ON /i.test(st) || /^UPDATE /i.test(st)) {
      ok = true;
    }
    if (!ok) {
      throw new Error(`${name} is marked backward-compatible but contains a statement that is not expand-only: "${st.slice(0, 80)}"; remove the marker (the previous release will then refuse to start) or split it into expand -> code -> contract`);
    }
  }
  return true;
}

/**
 * Reads the migration files. F6: every *.sql file must be named NNNN_lower_snake_case.sql and versions must be
 * unique; anything else is an error before anything runs. A misnamed file is never skipped silently (it would be a
 * schema change that never ships). Non-SQL files (README.md, ...) are ignored.
 */
export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const sqlFiles = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql'));
  const bad = sqlFiles.filter((f) => !MIGRATION_NAME.test(f));
  if (bad.length) throw new Error(`${bad.join(', ')}: not a valid migration file name (expected NNNN_lower_snake_case.sql); nothing was applied`);
  const files = sqlFiles.sort().map((f) => {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return { version: Number(f.slice(0, 4)), name: f, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex'), backwardCompatible: validateMetadata(f, sql) };
  });
  for (let i = 1; i < files.length; i++) {
    if (files[i].version === files[i - 1].version) {
      throw new Error(`duplicate migration version ${String(files[i].version).padStart(4, '0')} (${files[i - 1].name}, ${files[i].name}); nothing was applied`);
    }
  }
  return files;
}

const envMs = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export async function migrate(db: Db, dir = MIGRATIONS_DIR, opts: MigrateOptions = {}): Promise<{ applied: string[]; current: number; newerCompatible: string[] }> {
  const files = loadMigrations(dir);
  for (const f of files) {
    const bad = NON_TRANSACTIONAL.find((re) => re.test(f.sql));
    if (bad) throw new Error(`migration ${f.name} contains a statement that cannot run inside the migration transaction (${bad}); run it as a separate manual step`);
  }
  const statementTimeoutMs = Math.floor(opts.statementTimeoutMs ?? envMs('MIGRATION_STATEMENT_TIMEOUT_MS', 30 * 60000));
  const lockTimeoutMs = Math.floor(opts.lockTimeoutMs ?? envMs('MIGRATION_LOCK_TIMEOUT_MS', 60000));
  // Client-side timer slightly above the server-side one, so the server reports the precise error first.
  const q = (text: string, values?: any[]) => ({ text, values, query_timeout: statementTimeoutMs + 5000 });

  return withTx(
    db,
    async (tx) => {
      await tx.query(q(`SET LOCAL statement_timeout = ${statementTimeoutMs}`));
      // Waiting for another instance's migration is bounded by the migration timeout, not the request timeout.
      await tx.query(q(`SET LOCAL lock_timeout = ${statementTimeoutMs}`));
      await tx.query(q('SELECT pg_advisory_xact_lock($1)', [LOCKS.migrations]));
      await tx.query(q(`SET LOCAL lock_timeout = ${lockTimeoutMs}`));
      await tx.query(q(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`));
      // F5: whether the PREVIOUS release may run against a migration, recorded by the build that applied it
      await tx.query(q('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS backward_compatible boolean NOT NULL DEFAULT false'));
      const { rows } = await tx.query<{ version: number; name: string; checksum: string; backward_compatible: boolean }>(
        q('SELECT version, name, checksum, backward_compatible FROM schema_migrations ORDER BY version'),
      );
      const done = new Map(rows.map((r) => [r.version, r]));
      const newestKnown = files.length ? files[files.length - 1].version : 0;
      const newerCompatible: string[] = [];
      for (const r of rows) {
        const f = files.find((x) => x.version === r.version);
        if (f) {
          if (f.checksum !== r.checksum) throw new Error(`migration ${r.name} was modified after it was applied; add a new migration instead`);
          continue;
        }
        // F5: an applied migration this build does not have. Safe only when it is NEWER than everything this build
        // knows (we are the previous image: rolling deploy or rollback) AND its release declared it
        // backward-compatible (expand-only). Anything else is a diverged or incompatible schema.
        if (r.version < newestKnown) {
          throw new Error(`database has migration ${r.name} that is not in this build and is older than this build's newest migration (diverged history); refusing to run`);
        }
        if (!r.backward_compatible) {
          throw new Error(`database has newer migration ${r.name} that is not in this build and was not declared backward-compatible; refusing to run (deploy the newer release, or restore)`);
        }
        newerCompatible.push(r.name);
      }
      if (newerCompatible.length) {
        // The schema is ahead of this build: apply nothing (our own pending files would run out of order).
        const pending = files.filter((f) => !done.has(f.version));
        if (pending.length) {
          throw new Error(`database is at a newer schema (${newerCompatible.join(', ')}) but lacks ${pending.map((f) => f.name).join(', ')} from this build; refusing to run`);
        }
        console.warn(JSON.stringify({ level: 'warn', event: 'schema_newer_than_build', newerCompatible }));
        return { applied: [], current: newestKnown, newerCompatible };
      }
      const applied: string[] = [];
      for (const f of files) {
        if (done.has(f.version)) continue;
        try {
          await tx.query(q(f.sql));
        } catch (err: any) {
          const why = err?.code === '57014' ? 'statement timeout' : err?.code === '55P03' ? 'lock timeout (a table is busy)' : err?.message || String(err);
          throw new Error(`migration ${f.name} failed (${why}); nothing was applied — the schema is unchanged and a fixed re-run will recover`);
        }
        await tx.query(q('INSERT INTO schema_migrations (version, name, checksum, backward_compatible) VALUES ($1, $2, $3, $4)', [f.version, f.name, f.checksum, f.backwardCompatible]));
        applied.push(f.name);
      }
      return { applied, current: newestKnown, newerCompatible: [] };
    },
    { attempts: 1 }, // never auto-retry DDL; a deadlock here is reported and the operator re-runs
  );
}
