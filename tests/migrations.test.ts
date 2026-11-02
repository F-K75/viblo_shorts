// Migration runner rules (PR #3 corrective round: F5, F6).
//  F5: a build must be able to start against a schema one release newer when the newer migrations are declared
//      backward-compatible (rolling deploy, rollback to the previous image); anything else is still refused.
//  F6: a misnamed migration file must never be skipped silently; duplicate versions are rejected up front.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, pgSkip } from './helpers/pg.ts';
import { loadMigrations, migrate } from '../server/db/migrate.ts';

const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const REAL = path.join(import.meta.dirname, '..', 'server', 'db', 'migrations');
function dir(extra: Record<string, string> = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-rules-'));
  for (const f of fs.readdirSync(REAL)) fs.copyFileSync(path.join(REAL, f), path.join(d, f));
  for (const [n, sql] of Object.entries(extra)) fs.writeFileSync(path.join(d, n), sql);
  return d;
}
async function db() {
  const d = await createTestDatabase({ migrate: false });
  cleanups.push(() => d.drop());
  return d;
}
const tableExists = async (pool: any, t: string) => (await pool.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r !== null;

describe('F5: previous release can run against a newer, backward-compatible schema', { skip: pgSkip }, () => {
  test('release N-1 starts against schema N when N only adds backward-compatible changes; nothing is applied or changed', async () => {
    const d = await db();
    const next = dir({ '9100_add_optional_column.sql': '-- forge:backward-compatible\nALTER TABLE projects ADD COLUMN archived_at timestamptz;\n' });
    assert.ok((await migrate(d.pool, next)).applied.includes('9100_add_optional_column.sql'));
    const before = (await d.pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    const out = await migrate(d.pool, dir()); // the previous build: does not know 9100
    assert.deepEqual(out.applied, []);
    assert.deepEqual(out.newerCompatible, ['9100_add_optional_column.sql']);
    assert.deepEqual((await d.pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows, before);
  });

  test('a newer migration that is not declared backward-compatible is still refused', async () => {
    const d = await db();
    await migrate(d.pool, dir({ '9101_rename.sql': 'ALTER TABLE projects RENAME COLUMN title TO name;\n' }));
    await assert.rejects(migrate(d.pool, dir()), /9101_rename\.sql.*not declared backward-compatible/);
  });

  test('an unknown migration older than the newest one this build knows (diverged history) is refused', async () => {
    const d = await db();
    await migrate(d.pool, dir({ '9102_hotfix.sql': '-- forge:backward-compatible\nCREATE TABLE hotfix_t (id int);\n', '9103_next.sql': 'CREATE TABLE next_t (id int);\n' }));
    // a build that has 9103 but never had 9102
    await assert.rejects(migrate(d.pool, dir({ '9103_next.sql': 'CREATE TABLE next_t (id int);\n' })), /9102_hotfix\.sql.*not in this build/);
  });
});

describe('F6: migration files are never skipped silently', { skip: pgSkip }, () => {
  test('a misnamed .sql file is an error, and nothing is applied', async () => {
    for (const bad of ['9003a_add_index.sql', '9003_AddIndex.sql', '903_short.sql']) {
      const d = await db();
      await assert.rejects(migrate(d.pool, dir({ [bad]: 'CREATE TABLE should_not_exist (id int);' })), new RegExp(`${bad.replace('.', '\\.')}.*not a valid migration file name`));
      assert.equal(await tableExists(d.pool, 'should_not_exist'), false);
      assert.equal(await tableExists(d.pool, 'users'), false, 'nothing at all was applied');
    }
  });

  test('duplicate version numbers are rejected before anything runs', async () => {
    const d = await db();
    await assert.rejects(
      migrate(d.pool, dir({ '9004_a.sql': 'CREATE TABLE dup_a (id int);', '9004_b.sql': 'CREATE TABLE dup_b (id int);' })),
      /duplicate migration version 9004 \(9004_a\.sql, 9004_b\.sql\)/,
    );
    assert.equal(await tableExists(d.pool, 'users'), false);
  });

  test('the shipped migrations directory passes the rules (non-.sql files are ignored)', () => {
    const d = dir({ 'README.md': 'notes' });
    assert.deepEqual(loadMigrations(d).map((m) => m.name), loadMigrations(REAL).map((m) => m.name));
    assert.ok(loadMigrations(REAL).length >= 2);
  });
});
