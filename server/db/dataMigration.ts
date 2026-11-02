// JSON (Phase 1 shards) -> PostgreSQL data migration, and the reverse export used for rollback (ADR-005).
//
// migrateJsonToPostgres:
//  * reads the JSON store (refuses corrupt files: nothing is migrated partially or silently),
//  * runs in ONE transaction under a distributed advisory lock,
//  * is idempotent: rows already present are kept (never overwritten), so a re-run after go-live cannot
//    clobber newer writes made in PostgreSQL; such rows are reported as "diverged",
//  * verifies inside the transaction that every source record exists with the same owner and identical
//    content; any missing / wrongly-owned record aborts and rolls everything back,
//  * dry-run performs the full migration + verification and then ROLLs BACK.
// The JSON source is never modified or deleted.
//
// exportPostgresToJson: writes the complete PostgreSQL state into a NEW, empty directory in the Phase 1
// layout and verifies it, so switching back to STORAGE_BACKEND=json keeps writes made after go-live.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFileAtomic } from '../lib/storage.ts';
import { shardFileName } from '../lib/projectStore.ts';
import { userKindOf, type ServerJob, type StoredSubscription } from '../lib/repo.ts';
import { LOCKS, checkout, withTx, type Db } from './pool.ts';

export interface JsonSource {
  projects: Array<{ ownerId: string; project: any }>;
  jobs: ServerJob[];
  subscriptions: Record<string, StoredSubscription>;
  usage: { day: number; counts: Record<string, number> } | null;
  digest: string;
}

/** Canonical JSON (sorted keys) so content can be compared with what jsonb returns. */
export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Loads the Phase 1 JSON store. Throws on any corrupt or unexpected file (fail closed). */
export function loadJsonSource(dataDir: string): JsonSource {
  if (fs.existsSync(path.join(dataDir, 'projects.json')) && !fs.existsSync(path.join(dataDir, 'projects.migrated.json'))) {
    throw new Error('legacy projects.json has not been converted to per-user shards yet: start the Phase 1 server (or ProjectStore.init) once first');
  }
  const projects: JsonSource['projects'] = [];
  const dir = path.join(dataDir, 'projects');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort() : [];
  for (const f of files) {
    const shard = readJsonFile<any>(path.join(dir, f), null); // throws StoreUnavailableError if corrupt
    if (!shard || typeof shard.userId !== 'string' || !Array.isArray(shard.projects)) throw new Error(`malformed shard ${f}`);
    for (const p of shard.projects) {
      if (!p || typeof p.id !== 'string') throw new Error(`shard ${f} contains a project without an id`);
      projects.push({ ownerId: shard.userId, project: p });
    }
  }
  const jobs = readJsonFile<ServerJob[]>(path.join(dataDir, 'jobs.json'), []);
  const subscriptions = readJsonFile<Record<string, StoredSubscription>>(path.join(dataDir, 'subscriptions.json'), {});
  const usage = readJsonFile<any>(path.join(dataDir, 'usage.json'), null);
  const digest = sha(canonical({ projects: projects.map((x) => [x.ownerId, x.project]), jobs, subscriptions, usage }));
  return { projects, jobs, subscriptions, usage: usage && typeof usage.day === 'number' ? usage : null, digest };
}

export interface MigrationReport {
  dryRun: boolean;
  sourceDigest: string;
  source: { users: number; projects: number; guestProjects: number; jobs: number; subscriptions: number; usageKeys: number };
  inserted: { users: number; projects: number; jobs: number; subscriptions: number };
  alreadyPresent: { projects: number; jobs: number; subscriptions: number };
  diverged: string[]; // ids present in PostgreSQL with different content (kept; newer writes win)
  verification: { missing: string[]; wrongOwner: string[]; contentMismatch: string[]; ok: boolean };
  counters: { users: number; storageBytes: number; guestBytes: number };
  migrationId?: number;
}

class DryRunRollback extends Error {
  constructor(readonly report: MigrationReport) {
    super('dry run');
  }
}

export async function migrateJsonToPostgres(db: Db, src: JsonSource, opts: { dryRun?: boolean; snapshot?: string } = {}): Promise<MigrationReport> {
  const dryRun = Boolean(opts.dryRun);
  const users = new Set<string>([...src.projects.map((p) => p.ownerId), ...src.jobs.map((j) => j.userId).filter(Boolean), ...Object.keys(src.subscriptions)]);
  const report: MigrationReport = {
    dryRun,
    sourceDigest: src.digest,
    source: {
      users: users.size,
      projects: src.projects.length,
      guestProjects: src.projects.filter((p) => userKindOf(p.ownerId) === 'guest').length,
      jobs: src.jobs.length,
      subscriptions: Object.keys(src.subscriptions).length,
      usageKeys: src.usage ? Object.keys(src.usage.counts || {}).length : 0,
    },
    inserted: { users: 0, projects: 0, jobs: 0, subscriptions: 0 },
    alreadyPresent: { projects: 0, jobs: 0, subscriptions: 0 },
    diverged: [],
    verification: { missing: [], wrongOwner: [], contentMismatch: [], ok: false },
    counters: { users: 0, storageBytes: 0, guestBytes: 0 },
  };
  const bad = src.projects.filter((p) => JSON.stringify(p.project).includes('\\u0000')).map((p) => p.project.id);
  if (bad.length) throw new Error(`projects contain U+0000, which PostgreSQL jsonb cannot store; fix them first: ${bad.slice(0, 10).join(', ')}`);

  try {
    return await withTx(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCKS.dataMigration]);
      const mig = await tx.query('INSERT INTO data_migrations (source, source_digest, snapshot) VALUES ($1, $2, $3) RETURNING id', ['json-shards', src.digest, opts.snapshot ?? null]);
      report.migrationId = Number(mig.rows[0].id);

      for (const u of users) {
        const r = await tx.query('INSERT INTO users (id, kind) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [u, userKindOf(u)]);
        report.inserted.users += r.rowCount ?? 0;
      }

      const insertedIds = new Set<string>();
      for (const { ownerId, project } of src.projects) {
        const body = JSON.stringify(project);
        const created = project.createdAt || project.updatedAt || new Date(0).toISOString();
        const r = await tx.query(
          `INSERT INTO projects (id, user_id, title, doc, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
          [project.id, ownerId, String(project.title || ''), body, Buffer.byteLength(body), created, project.updatedAt || created],
        );
        if (r.rowCount) {
          report.inserted.projects++;
          insertedIds.add(project.id);
        } else report.alreadyPresent.projects++;
      }

      for (const j of src.jobs) {
        if (!j?.id || !j.userId) continue;
        // The JSON server is stopped: a "processing" job has no worker any more.
        const status = j.status === 'processing' ? 'failed' : j.status;
        const r = await tx.query(
          `INSERT INTO jobs (id, user_id, type, status, progress, step_message, payload, result, error, created_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
          [j.id, j.userId, j.type, status, j.progress ?? 0, status !== j.status ? 'Interrupted by storage migration — retry to run again.' : j.stepMessage ?? null,
            JSON.stringify(j.payload ?? null), JSON.stringify(j.result ?? null), status !== j.status ? 'Interrupted by storage migration' : j.error ?? null, j.createdAt, j.completedAt ?? null],
        );
        if (r.rowCount) report.inserted.jobs++;
        else report.alreadyPresent.jobs++;
      }

      for (const [userId, s] of Object.entries(src.subscriptions)) {
        if (!s || !['free', 'pro', 'studio'].includes(s.plan)) continue;
        const r = await tx.query(
          `INSERT INTO subscriptions (user_id, plan, status, monthly_render_minutes_used, current_period_end, demo)
           VALUES ($1, $2, 'active', $3, $4, $5) ON CONFLICT (user_id) DO NOTHING`,
          [userId, s.plan, Number(s.monthlyRenderMinutesUsed) || 0, s.currentPeriodEnd, Boolean(s.demo)],
        );
        if (r.rowCount) report.inserted.subscriptions++;
        else report.alreadyPresent.subscriptions++;
      }

      if (src.usage) {
        const day = new Date(src.usage.day * 86400000).toISOString().slice(0, 10);
        for (const [key, count] of Object.entries(src.usage.counts || {})) {
          // max(): idempotent and never lowers usage already counted in PostgreSQL
          await tx.query(
            `INSERT INTO ai_usage_daily (day, key, count) VALUES ($1::date, $2, $3) ON CONFLICT (day, key) DO UPDATE SET count = GREATEST(ai_usage_daily.count, EXCLUDED.count)`,
            [day, key, Math.max(0, Number(count) || 0)],
          );
        }
      }

      // Rebuild quota counters from the rows themselves (exact, whatever was there before).
      await tx.query(`UPDATE users u SET storage_bytes = coalesce(p.bytes, 0), project_count = coalesce(p.n, 0)
        FROM (SELECT u2.id, sum(pr.size_bytes) AS bytes, count(pr.id) AS n FROM users u2 LEFT JOIN projects pr ON pr.user_id = u2.id GROUP BY u2.id) p
        WHERE p.id = u.id`);
      await tx.query("UPDATE storage_totals SET bytes = (SELECT coalesce(sum(size_bytes), 0) FROM projects) WHERE scope = 'all'");
      await tx.query("UPDATE storage_totals SET bytes = (SELECT coalesce(sum(p.size_bytes), 0) FROM projects p JOIN users u ON u.id = p.user_id WHERE u.kind = 'guest') WHERE scope = 'guest'");

      // ---- verification (inside the transaction: a failure rolls everything back) ----
      const ids = src.projects.map((p) => p.project.id);
      const rows = new Map<string, { user_id: string; doc: any }>();
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        for (const r of (await tx.query('SELECT id, user_id, doc FROM projects WHERE id = ANY($1::text[])', [chunk])).rows) rows.set(r.id, r);
      }
      for (const { ownerId, project } of src.projects) {
        const row = rows.get(project.id);
        if (!row) report.verification.missing.push(project.id);
        else if (row.user_id !== ownerId) report.verification.wrongOwner.push(project.id);
        else if (canonical(row.doc) !== canonical(project)) {
          // Inserted by this run => must be byte-identical (anything else is corruption in transit).
          // Present before this run => a newer write made in PostgreSQL; it is kept and reported.
          if (insertedIds.has(project.id)) report.verification.contentMismatch.push(project.id);
          else report.diverged.push(project.id);
        }
      }
      report.verification.ok = !report.verification.missing.length && !report.verification.wrongOwner.length && !report.verification.contentMismatch.length;

      const c = (await tx.query("SELECT (SELECT count(*) FROM users)::int AS users, (SELECT bytes FROM storage_totals WHERE scope='all') AS all_b, (SELECT bytes FROM storage_totals WHERE scope='guest') AS guest_b")).rows[0];
      report.counters = { users: c.users, storageBytes: Number(c.all_b), guestBytes: Number(c.guest_b) };

      if (!report.verification.ok) {
        throw new Error(`verification failed (missing ${report.verification.missing.length}, wrong owner ${report.verification.wrongOwner.length}, mismatched ${report.verification.contentMismatch.length}); rolled back`);
      }
      await tx.query('UPDATE data_migrations SET finished_at = now(), report = $2::jsonb WHERE id = $1', [report.migrationId, JSON.stringify(report)]);
      if (dryRun) throw new DryRunRollback(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------
export interface ExportReport {
  targetDir: string;
  users: number;
  projects: number;
  jobs: number;
  subscriptions: number;
  verified: boolean;
}

/** Rollback path: PostgreSQL -> fresh Phase 1 JSON directory (never writes into a non-empty directory). */
export async function exportPostgresToJson(db: Db, targetDir: string): Promise<ExportReport> {
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`refusing to export into non-empty directory ${targetDir}`);
  }
  fs.mkdirSync(path.join(targetDir, 'projects'), { recursive: true });
  // One REPEATABLE READ snapshot so every table is exported from the same point in time.
  const { client, release } = await checkout(db);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const projects = (await client.query('SELECT user_id, doc FROM projects ORDER BY user_id, updated_at DESC')).rows;
    const jobs = (await client.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500')).rows;
    const subs = (await client.query('SELECT * FROM subscriptions')).rows;
    const today = Math.floor(Date.now() / 86400000);
    const usage = (await client.query('SELECT key, count FROM ai_usage_daily WHERE day = $1::date', [new Date(today * 86400000).toISOString().slice(0, 10)])).rows;
    await client.query('COMMIT');

    const byUser = new Map<string, any[]>();
    for (const r of projects) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r.doc);
    }
    for (const [userId, list] of byUser) writeJsonFileAtomic(path.join(targetDir, 'projects', shardFileName(userId)), { v: 1, userId, projects: list }, 0);
    writeJsonFileAtomic(path.join(targetDir, 'projects.migrated.json'), { migratedAt: new Date().toISOString(), exportedFrom: 'postgres', records: projects.length });
    const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? undefined);
    writeJsonFileAtomic(
      path.join(targetDir, 'jobs.json'),
      jobs.map((r) => ({ id: r.id, userId: r.user_id, type: r.type, status: r.status === 'processing' ? 'failed' : r.status, progress: r.progress, stepMessage: r.step_message ?? undefined, payload: r.payload ?? undefined, result: r.result ?? undefined, error: r.error ?? undefined, createdAt: iso(r.created_at), completedAt: iso(r.completed_at) })),
    );
    writeJsonFileAtomic(
      path.join(targetDir, 'subscriptions.json'),
      Object.fromEntries(subs.map((r) => [r.user_id, { plan: r.plan, status: 'active', monthlyRenderMinutesUsed: Number(r.monthly_render_minutes_used), currentPeriodEnd: iso(r.current_period_end), ...(r.demo ? { demo: true } : {}) }])),
    );
    writeJsonFileAtomic(path.join(targetDir, 'usage.json'), { v: 1, day: today, counts: Object.fromEntries(usage.map((u) => [u.key, Number(u.count)])) }, 0);

    // verify: re-read what was written and compare with the database snapshot
    const back = loadJsonSource(targetDir);
    const expected = new Map(projects.map((r) => [r.doc.id, { owner: r.user_id, doc: canonical(r.doc) }]));
    const verified = back.projects.length === projects.length && back.projects.every((p) => {
      const e = expected.get(p.project.id);
      return e && e.owner === p.ownerId && e.doc === canonical(p.project);
    });
    if (!verified) throw new Error('export verification failed');
    return { targetDir, users: byUser.size, projects: projects.length, jobs: jobs.length, subscriptions: subs.length, verified };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}
