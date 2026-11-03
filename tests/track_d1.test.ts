// Track D-1 (security and data hardening). One section per item; each was written red-first against the previous
// implementation (main @ 6ee9c11) before its fix.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRepo } from '../server/lib/jsonRepo.ts';
import { PostgresRepo } from '../server/db/pgRepo.ts';
import { ProjectOwnershipError, type Repo } from '../server/lib/repo.ts';
import type { StoreLimits } from '../server/lib/projectStore.ts';
import { createTestDatabase, pgSkip, type TestDb } from './helpers/pg.ts';

const KB = 1024;
const limits: StoreLimits = {
  maxProjectBytes: 64 * KB,
  guestMaxProjects: 3,
  guestMaxBytes: 100 * KB,
  userMaxProjects: 50,
  userMaxBytes: 400 * KB,
  guestPoolMaxBytes: 150 * KB,
  totalMaxBytes: 100_000 * KB,
  minFreeDiskBytes: 0,
};
const now = () => new Date().toISOString();
const proj = (id: string, userId: string, size = 10, extra: object = {}) => ({ id, userId, title: id, topic: 'x'.repeat(size), createdAt: now(), updatedAt: now(), ...extra });

const dbs: TestDb[] = [];
after(async () => {
  for (const d of dbs) await d.drop().catch(() => {});
});
async function makeRepo(kind: 'json' | 'postgres'): Promise<{ r: Repo; db?: TestDb }> {
  if (kind === 'json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-json-'));
    const r = new JsonRepo(dir, path.join(dir, 'backups'), limits, 0);
    r.init();
    return { r };
  }
  const db = await createTestDatabase();
  dbs.push(db);
  return { r: new PostgresRepo(db.pool, limits), db };
}

// ---------------------------------------------------------------- D4a / F8: project ownership in the save itself
for (const kind of ['json', 'postgres'] as const) {
  describe(`F8 (${kind}): saveProject enforces ownership and never resurrects a deleted project`, { skip: kind === 'postgres' ? pgSkip : false }, () => {
    test('an update that requires the project to exist does not re-create it after a concurrent delete', async () => {
      const { r, db } = await makeRepo(kind);
      const p = proj('proj_d1_upd', 'alice', 20);
      await r.saveProject('alice', p);
      // the route has already read the project (it existed); the owner deletes it before the save runs
      assert.equal(await r.deleteProject('alice', p.id), true);
      await assert.rejects(
        (r.saveProject as any)('alice', { ...p, title: 'late update' }, { mustExist: true }),
        (e: any) => e?.name === 'ProjectNotFoundError',
        'the late update is refused as "not found"',
      );
      assert.equal(await r.getProject(p.id), null, 'the deleted project was not re-created');
      assert.deepEqual(await r.listProjects('alice'), []);
      if (db) {
        const u = (await db.pool.query('SELECT project_count, storage_bytes FROM users WHERE id = $1', ['alice'])).rows[0];
        assert.deepEqual([Number(u.project_count), Number(u.storage_bytes)], [0, 0], 'counters are unchanged by the refused update');
      }
      // an update of an existing project with mustExist still works
      await r.saveProject('alice', proj('proj_d1_live', 'alice'));
      await (r.saveProject as any)('alice', { ...proj('proj_d1_live', 'alice'), title: 'renamed' }, { mustExist: true });
      assert.equal((await r.getProject('proj_d1_live'))!.project.title, 'renamed');
    });
  });
}

describe('F8 (postgres): concurrent saves of one new id by two users', { skip: pgSkip }, () => {
  test('exactly one user wins each race; the loser gets ProjectOwnershipError; documents and counters stay consistent', async () => {
    const { r, db } = await makeRepo('postgres');
    for (let round = 0; round < 10; round++) {
      const id = `proj_race_${round}`;
      const results = await Promise.allSettled([
        r.saveProject('alice', proj(id, 'alice', 100, { title: `alice-${round}` })),
        r.saveProject('bob', proj(id, 'bob', 300, { title: `bob-${round}` })),
      ]);
      const won = results.filter((x) => x.status === 'fulfilled').length;
      assert.equal(won, 1, `round ${round}: ${JSON.stringify(results.map((x) => x.status))}`);
      const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      assert.ok(lost.reason instanceof ProjectOwnershipError, `round ${round}: ${lost.reason}`);
      const row = (await db!.pool.query('SELECT user_id, title FROM projects WHERE id = $1', [id])).rows[0];
      assert.equal(row.title, `${row.user_id}-${round}`, `round ${round}: the document belongs to its owner (${JSON.stringify(row)})`);
    }
    // every user's counters equal what they actually own
    const drift = (
      await db!.pool.query(
        `SELECT u.id, u.project_count, u.storage_bytes, count(p.id)::int AS n, coalesce(sum(p.size_bytes), 0)::bigint AS bytes
           FROM users u LEFT JOIN projects p ON p.user_id = u.id GROUP BY u.id
         HAVING u.project_count <> count(p.id) OR u.storage_bytes <> coalesce(sum(p.size_bytes), 0)`,
      )
    ).rows;
    assert.deepEqual(drift, [], 'no counter drift');
    const totals = (await db!.pool.query("SELECT bytes FROM storage_totals WHERE scope = 'all'")).rows[0];
    const sum = (await db!.pool.query('SELECT coalesce(sum(size_bytes), 0)::bigint AS s FROM projects')).rows[0];
    assert.equal(String(totals.bytes), String(sum.s), 'the global storage total equals the stored projects');
  });
});
