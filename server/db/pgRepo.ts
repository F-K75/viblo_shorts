// PostgreSQL Repo (ADR-003). Multi-instance safe:
//  * project writes: one transaction, per-user row lock (users FOR UPDATE) => quotas exact under concurrency;
//    lock order is always users -> projects -> storage_totals('all') -> storage_totals('guest') (no deadlocks)
//  * AI quota: conditional upserts in one transaction (all-or-nothing reservation)
//  * rate limits: token buckets computed with the database clock (consistent across instances)
//  * jobs: FOR UPDATE SKIP LOCKED claim, worker heartbeats, reaper for dead workers
import { StoreLimitError, type StoreLimits } from '../lib/projectStore.ts';
import { ProjectOwnershipError, userKindOf, type AdmissionContext, type AiSettlement, type HeartbeatResult, type JobAdmission, type JobDenial, type QuotaEntry, type ReapResult, type Repo, type ServerJob, type StoredSubscription } from '../lib/repo.ts';
import { LOCKS, withTx, type Db, type Tx } from './pool.ts';

const dayDate = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? undefined);

function rowToJob(r: any): ServerJob {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    status: r.status,
    progress: r.progress,
    stepMessage: r.step_message ?? undefined,
    payload: r.payload ?? undefined,
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    workerId: r.worker_id ?? undefined,
    attempts: r.attempts ?? 0,
    queuedAt: iso(r.queued_at),
    claimedAt: iso(r.claimed_at),
    createdAt: iso(r.created_at),
    completedAt: iso(r.completed_at),
  };
}

async function ensureUser(tx: Tx | Db, userId: string) {
  await tx.query(
    `INSERT INTO users (id, kind) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
    [userId, userKindOf(userId)],
  );
}

export class PostgresRepo implements Repo {
  readonly kind = 'postgres' as const;
  constructor(
    readonly db: Db,
    private readonly limits: StoreLimits,
  ) {}

  async health() {
    const t0 = Date.now();
    try {
      await this.db.query('SELECT 1');
      return { ok: true, detail: { database: 'ok', latencyMs: Date.now() - t0, pool: { total: this.db.totalCount, idle: this.db.idleCount, waiting: this.db.waitingCount } } };
    } catch (err: any) {
      return { ok: false, detail: { database: 'unavailable', error: String(err?.code || err?.message || err).slice(0, 120) } };
    }
  }
  async close() {
    await this.db.end();
  }

  // ---------- projects ----------
  async listProjects(userId: string) {
    const { rows } = await this.db.query('SELECT doc FROM projects WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return rows.map((r) => r.doc);
  }
  async listAllProjects(limit: number) {
    const { rows } = await this.db.query('SELECT doc FROM projects ORDER BY updated_at DESC LIMIT $1', [limit]);
    return { projects: rows.map((r) => r.doc), unreadable: 0 };
  }
  async getProject(id: string) {
    const { rows } = await this.db.query('SELECT doc, user_id FROM projects WHERE id = $1', [id]);
    return rows[0] ? { project: rows[0].doc, ownerId: rows[0].user_id } : null;
  }

  async saveProject(userId: string, project: any) {
    const L = this.limits;
    const body = JSON.stringify(project);
    const size = Buffer.byteLength(body);
    if (size > L.maxProjectBytes) {
      throw new StoreLimitError(413, 'project_too_large', `Project is too large (max ${Math.round(L.maxProjectBytes / 1024)} KB).`);
    }
    // jsonb cannot store U+0000; reject clearly instead of failing with a 500.
    if (body.includes('\\u0000')) throw new StoreLimitError(400, 'invalid_content', 'Project contains unsupported characters (NUL).');
    const guest = userKindOf(userId) === 'guest';
    await withTx(this.db, async (tx) => {
      await ensureUser(tx, userId);
      const u = (await tx.query('SELECT storage_bytes, project_count FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      const existing = (await tx.query('SELECT user_id, size_bytes FROM projects WHERE id = $1 FOR UPDATE', [project.id])).rows[0];
      if (existing && existing.user_id !== userId) throw new ProjectOwnershipError();
      const delta = size - (existing?.size_bytes ?? 0);
      const countDelta = existing ? 0 : 1;
      const maxProjects = guest ? L.guestMaxProjects : L.userMaxProjects;
      if (countDelta && u.project_count + 1 > maxProjects) {
        throw new StoreLimitError(409, 'project_limit', guest
          ? `Guest accounts can keep up to ${maxProjects} projects. Sign up for more, or delete old projects.`
          : `Project limit reached (${maxProjects}). Delete old projects first.`);
      }
      if (delta > 0) {
        const maxBytes = guest ? L.guestMaxBytes : L.userMaxBytes;
        if (Number(u.storage_bytes) + delta > maxBytes) {
          throw new StoreLimitError(409, 'storage_quota_exceeded', `Storage limit reached (${Math.round(maxBytes / 1048576)} MB${guest ? ' for guest accounts' : ''}). Delete old projects first.`);
        }
      }
      if (delta !== 0) {
        const all = (await tx.query("UPDATE storage_totals SET bytes = GREATEST(0, bytes + $1) WHERE scope = 'all' RETURNING bytes", [delta])).rows[0];
        if (delta > 0 && Number(all.bytes) > L.totalMaxBytes) throw new StoreLimitError(507, 'storage_full', 'Project storage is temporarily full. Please try again later.');
        if (guest) {
          const g = (await tx.query("UPDATE storage_totals SET bytes = GREATEST(0, bytes + $1) WHERE scope = 'guest' RETURNING bytes", [delta])).rows[0];
          if (delta > 0 && Number(g.bytes) > L.guestPoolMaxBytes) throw new StoreLimitError(507, 'guest_storage_full', 'Guest storage is temporarily full. Sign up for an account to keep saving projects.');
        }
      }
      await tx.query(
        `INSERT INTO projects (id, user_id, title, doc, size_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, doc = EXCLUDED.doc, size_bytes = EXCLUDED.size_bytes, updated_at = EXCLUDED.updated_at`,
        [project.id, userId, String(project.title || ''), body, size, project.createdAt, project.updatedAt],
      );
      await tx.query('UPDATE users SET storage_bytes = GREATEST(0, storage_bytes + $2), project_count = project_count + $3 WHERE id = $1', [userId, delta, countDelta]);
    });
  }

  async deleteProject(ownerId: string, id: string) {
    return withTx(this.db, async (tx) => {
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
      const del = (await tx.query('DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING size_bytes', [id, ownerId])).rows[0];
      if (!del) return false;
      const size = Number(del.size_bytes);
      await tx.query("UPDATE storage_totals SET bytes = GREATEST(0, bytes - $1) WHERE scope = 'all'", [size]);
      if (userKindOf(ownerId) === 'guest') await tx.query("UPDATE storage_totals SET bytes = GREATEST(0, bytes - $1) WHERE scope = 'guest'", [size]);
      await tx.query('UPDATE users SET storage_bytes = GREATEST(0, storage_bytes - $2), project_count = GREATEST(0, project_count - 1) WHERE id = $1', [ownerId, size]);
      return true;
    });
  }

  // ---------- subscriptions ----------
  async getSubscription(userId: string): Promise<StoredSubscription | null> {
    const r = (await this.db.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId])).rows[0];
    if (!r) return null;
    return {
      plan: r.plan,
      status: 'active',
      monthlyRenderMinutesUsed: Number(r.monthly_render_minutes_used),
      currentPeriodEnd: iso(r.current_period_end),
      ...(r.demo ? { demo: true } : {}),
    };
  }
  async putSubscription(userId: string, sub: StoredSubscription) {
    await withTx(this.db, async (tx) => {
      await ensureUser(tx, userId);
      await tx.query(
        `INSERT INTO subscriptions (user_id, plan, status, monthly_render_minutes_used, current_period_end, demo, updated_at)
         VALUES ($1, $2, 'active', $3, $4, $5, now())
         ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, monthly_render_minutes_used = EXCLUDED.monthly_render_minutes_used,
           current_period_end = EXCLUDED.current_period_end, demo = EXCLUDED.demo, updated_at = now()`,
        [userId, sub.plan, sub.monthlyRenderMinutesUsed || 0, sub.currentPeriodEnd, Boolean(sub.demo)],
      );
    });
  }
  async addRenderMinutes(userId: string, seconds: number, defaults: StoredSubscription) {
    await withTx(this.db, async (tx) => {
      await ensureUser(tx, userId);
      await tx.query(
        `INSERT INTO subscriptions (user_id, plan, status, monthly_render_minutes_used, current_period_end, demo)
         VALUES ($1, $2, 'active', $3, $4, false)
         ON CONFLICT (user_id) DO UPDATE SET monthly_render_minutes_used = subscriptions.monthly_render_minutes_used + EXCLUDED.monthly_render_minutes_used, updated_at = now()`,
        [userId, defaults.plan, +(seconds / 60).toFixed(2), defaults.currentPeriodEnd],
      );
    });
  }

  // ---------- AI quota ----------
  // R-02. Lock order (both paths, every instance): the call's own ai_reservations row, then ai_usage_daily rows
  // in ascending key order. The old refund updated both rows in one `key = ANY(...)` statement, i.e. in scan
  // order, and deadlocked against reservations that locked user -> ip.
  async reserveAi(entries: QuotaEntry[], day: number, reservationId: string) {
    const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    try {
      await withTx(this.db, async (tx) => {
        // Idempotency first: a retried reserve whose first attempt committed is a no-op (never charges twice).
        const ins = await tx.query(
          `INSERT INTO ai_reservations (id, day, keys, status) VALUES ($1, $2::date, $3::text[], 'reserved') ON CONFLICT (id) DO NOTHING RETURNING id`,
          [reservationId, dayDate(day), sorted.map((e) => e.key)],
        );
        if (ins.rowCount === 0) return;
        for (const e of sorted) {
          const r = await tx.query(
            `INSERT INTO ai_usage_daily (day, key, count) SELECT $1::date, $2, 1 WHERE $3::int > 0
             ON CONFLICT (day, key) DO UPDATE SET count = ai_usage_daily.count + 1 WHERE ai_usage_daily.count < $3::int
             RETURNING count`,
            [dayDate(day), e.key, e.limit],
          );
          if (r.rowCount === 0) throw new QuotaRejected(e.key); // rolls back the reservation row too
        }
      });
      return { ok: true as const };
    } catch (err) {
      if (err instanceof QuotaRejected) return { ok: false as const, key: err.key };
      throw err;
    }
  }

  async settleAi(reservationId: string, outcome: AiSettlement): Promise<'settled' | 'already_settled'> {
    return withTx(this.db, async (tx) => {
      // Conditional transition: only an open reservation can be settled, so a duplicate/retried settle is a no-op.
      const r = await tx.query(
        `UPDATE ai_reservations SET status = $2, settled_at = now() WHERE id = $1 AND status = 'reserved' RETURNING day, keys`,
        [reservationId, outcome === 'commit' ? 'committed' : 'refunded'],
      );
      if (r.rowCount === 0) return 'already_settled' as const;
      if (outcome === 'refund') {
        const { day, keys } = r.rows[0];
        for (const key of [...(keys as string[])].sort()) {
          await tx.query('UPDATE ai_usage_daily SET count = GREATEST(0, count - 1) WHERE day = $1 AND key = $2', [day, key]);
        }
      }
      return 'settled' as const;
    });
  }

  async expireAiReservations(ttlMs: number) {
    // SKIP LOCKED: a reservation being settled right now by its request is left alone (no lock wait, no double settle).
    const { rows } = await this.db.query(
      `SELECT id FROM ai_reservations WHERE status = 'reserved' AND created_at < now() - ($1::int * interval '1 millisecond')
       ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [Math.max(1, Math.floor(ttlMs))],
    );
    let n = 0;
    for (const { id } of rows) if ((await this.settleAi(id, 'refund')) === 'settled') n++;
    return n;
  }

  async peekAi(key: string, day: number) {
    const r = (await this.db.query('SELECT count FROM ai_usage_daily WHERE day = $1::date AND key = $2', [dayDate(day), key])).rows[0];
    return r ? Number(r.count) : 0;
  }

  // ---------- rate limiting ----------
  async takeRateTokens(list: Array<{ key: string; max: number }>) {
    const sorted = [...list].sort((a, b) => a.key.localeCompare(b.key)); // fixed lock order
    return withTx(this.db, async (tx) => {
      const tokens: number[] = [];
      for (const { key, max } of sorted) {
        const r = await tx.query(
          `INSERT INTO rate_buckets (key, tokens, refilled_at) VALUES ($1, $2::float8, now())
           ON CONFLICT (key) DO UPDATE SET
             tokens = LEAST($2::float8, rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - rate_buckets.refilled_at)) / 60.0 * $2::float8),
             refilled_at = now()
           RETURNING tokens`,
          [key, max],
        );
        tokens.push(Number(r.rows[0].tokens));
      }
      if (tokens.some((t) => t < 1)) return { ok: false, remaining: 0 };
      await tx.query('UPDATE rate_buckets SET tokens = tokens - 1 WHERE key = ANY($1::text[])', [sorted.map((b) => b.key)]);
      return { ok: true, remaining: Math.floor(Math.min(...tokens) - 1) };
    });
  }
  async incrementWindow(key: string, windowId: number, limit: number) {
    const r = await this.db.query(
      `INSERT INTO window_counters (key, window_id, count) SELECT $1, $2, 1 WHERE $3::int > 0
       ON CONFLICT (key, window_id) DO UPDATE SET count = window_counters.count + 1 WHERE window_counters.count < $3::int
       RETURNING count`,
      [key, windowId, limit],
    );
    if (r.rowCount === 0) return { ok: false, count: limit };
    return { ok: true, count: Number(r.rows[0].count) };
  }

  // ---------- jobs ----------
  async listJobs(userId: string, limit: number) {
    const { rows } = await this.db.query('SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    return rows.map(rowToJob);
  }
  async getJob(id: string) {
    const r = (await this.db.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
    return r ? rowToJob(r) : null;
  }
  async activeJobs(userId: string) {
    const { rows } = await this.db.query("SELECT * FROM jobs WHERE user_id = $1 AND status IN ('queued', 'processing')", [userId]);
    return rows.map(rowToJob);
  }
  /** Admission context, read under the jobAdmission advisory lock (so it cannot change before the insert commits). */
  private async admissionContext(tx: Tx): Promise<AdmissionContext> {
    const r = await tx.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'queued'");
    return { globalQueued: r.rows[0].n };
  }
  // Admission + insert: every admission on every instance is serialized by one advisory lock, then the user's row
  // lock. So both the per-user limit and the global queue cap are exact under concurrency (tests/render_queue.test.ts B3).
  async insertJob(job: ServerJob, admit?: JobAdmission): Promise<JobDenial | null> {
    return withTx(this.db, async (tx) => {
      if (admit) await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCKS.jobAdmission]);
      await ensureUser(tx, job.userId);
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [job.userId]);
      if (admit) {
        const active = (await tx.query("SELECT * FROM jobs WHERE user_id = $1 AND status IN ('queued', 'processing')", [job.userId])).rows.map(rowToJob);
        const denied = admit(active, await this.admissionContext(tx));
        if (denied) return denied;
      }
      await tx.query(
        `INSERT INTO jobs (id, user_id, type, status, progress, step_message, payload, created_at, queued_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())`,
        [job.id, job.userId, job.type, job.status, job.progress, job.stepMessage ?? null, JSON.stringify(job.payload ?? null), job.createdAt],
      );
      return null;
    });
  }
  // Fair claim (R-04). Candidates: users with queued jobs and fewer than maxRunningPerUser processing jobs, least
  // recently served first (a user never served before goes first), then oldest job. Each candidate is tried in its own
  // short transaction: the user's row is locked (waiting if another claim/admission holds it), the running count is
  // re-checked, then one queued job is claimed with SKIP LOCKED. Two instances can therefore never start more than
  // maxRunningPerUser jobs of one user, and since a transaction holds at most one user lock, claims cannot deadlock.
  async claimNextJob(workerId: string, maxRunningPerUser = 1) {
    const { rows: candidates } = await this.db.query(
      `SELECT q.user_id, min(q.created_at) AS oldest, (SELECT max(c.claimed_at) FROM jobs c WHERE c.user_id = q.user_id) AS last_served
         FROM jobs q WHERE q.status = 'queued'
        GROUP BY q.user_id
       HAVING (SELECT count(*) FROM jobs p WHERE p.user_id = q.user_id AND p.status = 'processing') < $1
        ORDER BY last_served ASC NULLS FIRST, oldest ASC
        LIMIT 20`,
      [maxRunningPerUser],
    );
    for (const c of candidates) {
      const claimed = await withTx(this.db, async (tx) => {
        await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [c.user_id]);
        const running = (await tx.query("SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND status = 'processing'", [c.user_id])).rows[0].n;
        if (running >= maxRunningPerUser) return null;
        const r = await tx.query(
          `UPDATE jobs SET status = 'processing', worker_id = $1, heartbeat_at = now(), claimed_at = now(), attempts = attempts + 1,
                  progress = 20, step_message = 'Rendering...'
            WHERE id = (SELECT id FROM jobs WHERE user_id = $2 AND status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING *`,
          [workerId, c.user_id],
        );
        return r.rows[0] ? rowToJob(r.rows[0]) : null;
      });
      if (claimed) return claimed;
    }
    return null;
  }
  async heartbeat(jobId: string, workerId: string, progress: number, stepMessage: string): Promise<HeartbeatResult> {
    const r = await this.db.query(
      `UPDATE jobs SET heartbeat_at = now(), progress = $3, step_message = $4 WHERE id = $1 AND worker_id = $2 AND status = 'processing' RETURNING id`,
      [jobId, workerId, progress, stepMessage],
    );
    if (r.rowCount) return 'ok';
    const cur = (await this.db.query('SELECT status FROM jobs WHERE id = $1', [jobId])).rows[0];
    return cur?.status === 'cancelled' ? 'cancelled' : 'lost';
  }
  async finishJob(job: ServerJob, workerId: string) {
    const r = await this.db.query(
      `UPDATE jobs SET status = $3, progress = $4, step_message = $5, result = $6::jsonb, error = $7, completed_at = $8, worker_id = NULL, heartbeat_at = NULL
       WHERE id = $1 AND worker_id = $2 AND status = 'processing'`,
      [job.id, workerId, job.status, job.progress, job.stepMessage ?? null, JSON.stringify(job.result ?? null), job.error ?? null, job.completedAt ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }
  // F7: completion and charge commit together or not at all. A cancel that won the race leaves rowCount 0: no charge.
  async completeJob(job: ServerJob, workerId: string, billSeconds: number, defaults: StoredSubscription) {
    return withTx(this.db, async (tx) => {
      await ensureUser(tx, job.userId);
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [job.userId]);
      const r = await tx.query(
        `UPDATE jobs SET status = 'completed', progress = $3, step_message = $4, result = $5::jsonb, error = NULL, completed_at = $6, worker_id = NULL, heartbeat_at = NULL
         WHERE id = $1 AND worker_id = $2 AND status = 'processing'`,
        [job.id, workerId, job.progress, job.stepMessage ?? null, JSON.stringify(job.result ?? null), job.completedAt ?? new Date().toISOString()],
      );
      if (!r.rowCount) return false;
      await tx.query(
        `INSERT INTO subscriptions (user_id, plan, status, monthly_render_minutes_used, current_period_end, demo)
         VALUES ($1, $2, 'active', $3, $4, false)
         ON CONFLICT (user_id) DO UPDATE SET monthly_render_minutes_used = subscriptions.monthly_render_minutes_used + EXCLUDED.monthly_render_minutes_used, updated_at = now()`,
        [job.userId, defaults.plan, +(billSeconds / 60).toFixed(2), defaults.currentPeriodEnd],
      );
      return true;
    });
  }
  async releaseJob(jobId: string, workerId: string) {
    const r = await this.db.query(
      `UPDATE jobs SET status = 'queued', worker_id = NULL, heartbeat_at = NULL, attempts = greatest(attempts - 1, 0), progress = 5,
              step_message = 'Re-queued: the server rendering it was restarted.', queued_at = now()
       WHERE id = $1 AND worker_id = $2 AND status = 'processing'`,
      [jobId, workerId],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async cancelJob(jobId: string) {
    const r = await this.db.query(
      `UPDATE jobs SET status = 'cancelled', step_message = 'Job cancelled by user request.', completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'processing') RETURNING *`,
      [jobId],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }
  async requeueJob(jobId: string, admit?: JobAdmission): Promise<{ job: ServerJob | null; denied?: JobDenial }> {
    return withTx(this.db, async (tx) => {
      if (admit) await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCKS.jobAdmission]);
      const owner = (await tx.query('SELECT user_id FROM jobs WHERE id = $1', [jobId])).rows[0];
      if (!owner) return { job: null };
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [owner.user_id]);
      if (admit) {
        const active = (await tx.query("SELECT * FROM jobs WHERE user_id = $1 AND id <> $2 AND status IN ('queued', 'processing')", [owner.user_id, jobId])).rows.map(rowToJob);
        const denied = admit(active, await this.admissionContext(tx));
        if (denied) return { job: null, denied };
      }
      const r = await tx.query(
        `UPDATE jobs SET status = 'queued', progress = 5, error = NULL, result = NULL, completed_at = NULL, worker_id = NULL, heartbeat_at = NULL,
           step_message = 'Re-queued for rendering...', attempts = 0, queued_at = now()
         WHERE id = $1 AND status IN ('failed', 'cancelled') RETURNING *`,
        [jobId],
      );
      return { job: r.rows[0] ? rowToJob(r.rows[0]) : null };
    });
  }
  // Crash recovery: a stale job goes back to the queue (another instance renders it) until it has used its attempts.
  async reapStaleJobs(staleMs: number, maxAttempts: number): Promise<ReapResult> {
    const r = await this.db.query(
      `UPDATE jobs SET
         status       = CASE WHEN attempts < $2 THEN 'queued' ELSE 'failed' END,
         error        = CASE WHEN attempts < $2 THEN NULL ELSE 'Render worker stopped responding (instance restart or crash) on every attempt' END,
         step_message = CASE WHEN attempts < $2 THEN 'Re-queued: the server rendering it stopped responding.'
                             ELSE 'Failed: render worker stopped responding — retry to run again.' END,
         completed_at = CASE WHEN attempts < $2 THEN NULL ELSE now() END,
         queued_at    = CASE WHEN attempts < $2 THEN now() ELSE queued_at END,
         progress     = CASE WHEN attempts < $2 THEN 5 ELSE progress END,
         worker_id = NULL, heartbeat_at = NULL
       WHERE id IN (SELECT id FROM jobs WHERE status = 'processing' AND heartbeat_at < now() - ($1::int * interval '1 millisecond') FOR UPDATE SKIP LOCKED)
       RETURNING status`,
      [staleMs, maxAttempts],
    );
    const requeued = r.rows.filter((x: any) => x.status === 'queued').length;
    return { requeued, failed: r.rows.length - requeued };
  }
  async expireQueuedJobs(ttlMs: number) {
    const r = await this.db.query(
      `UPDATE jobs SET status = 'failed', error = 'Expired: waited too long in the render queue', step_message = 'Expired: waited too long in the render queue — retry to queue it again.',
              completed_at = now()
       WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND coalesce(queued_at, created_at) < now() - ($1::int * interval '1 millisecond') FOR UPDATE SKIP LOCKED)`,
      [ttlMs],
    );
    return r.rowCount ?? 0;
  }

  async sweep() {
    await this.db.query("DELETE FROM rate_buckets WHERE refilled_at < now() - interval '10 minutes'");
    await this.db.query('DELETE FROM window_counters WHERE window_id < $1', [Math.floor(Date.now() / 3600000) - 48]);
    await this.db.query("DELETE FROM ai_usage_daily WHERE day < (now() - interval '35 days')::date");
    await this.db.query("DELETE FROM ai_reservations WHERE status <> 'reserved' AND settled_at < now() - interval '35 days'");
  }
}

class QuotaRejected extends Error {
  constructor(readonly key: string) {
    super(`quota exhausted for ${key}`);
  }
}
