// JSON-file Repo (Phase 1 storage, single instance). Kept as the development default and as the
// rollback target of the PostgreSQL migration.
// Track B: fair claim, per-user running cap, queue cap, bounded crash retries and exactly-once billing. A completed
// job records billedSeconds; the subscription records the job id when charged; init() charges any completed job whose
// id is missing (crash between the two writes), so the charge happens exactly once.
import path from 'path';
import { ProjectStore, type StoreLimits } from './projectStore.ts';
import { readJsonFile, writeJsonFileAtomic } from './storage.ts';
import { UsageLedger } from './usage.ts';
import { ProjectNotFoundError, ProjectOwnershipError, type SaveProjectOptions, type AiSettlement, type HeartbeatResult, type JobAdmission, type JobDenial, type QuotaEntry, type ReapResult, type Repo, type WindowEntry, STATS_RETENTION_WINDOWS, type ServerJob, type StoredSubscription } from './repo.ts';

const MAX_STORED_JOBS = 500;

export class JsonRepo implements Repo {
  readonly kind = 'json' as const;
  readonly store: ProjectStore;
  readonly ledger: UsageLedger;
  private readonly jobsFile: string;
  private readonly subsFile: string;
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private windows = new Map<string, { windowId: number; count: number }>();
  private heartbeats = new Map<string, number>(); // jobId -> last heartbeat (ms)
  // Track A. Single process: in-memory and atomic (no await between check and update). Not persisted: a restart
  // forgets redemptions (the provider itself also rejects reused tokens) and the current windows.
  private redemptions = new Map<string, number>(); // key -> expires at (ms)
  private limitWindows = new Map<string, number>(); // `${key}@${windowId}` -> count
  private stats = new Map<string, number>(); // `${key}@${windowId}` -> count

  constructor(
    dataDir: string,
    backupDir: string,
    limits: StoreLimits,
    ledgerFlushMs: number,
    /** RENDER_MAX_ATTEMPTS: a job left processing by a dead process is requeued until it has used this many claims. */
    private readonly maxAttempts = 2,
  ) {
    this.store = new ProjectStore(dataDir, backupDir, limits);
    this.ledger = new UsageLedger(path.join(dataDir, 'usage.json'), ledgerFlushMs);
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.subsFile = path.join(dataDir, 'subscriptions.json');
  }

  /**
   * Runs the Phase 1 store init (incl. legacy migration), recovers jobs orphaned by a previous process and charges
   * completed jobs whose charge was not recorded (crash between completion and charge).
   */
  init() {
    const report = this.store.init();
    try {
      const jobs = this.jobs();
      let changed = false;
      // Single instance: a job left "processing" by a previous process has no live worker. It goes back to the queue
      // unless it already used its attempts (a job that crashes the process every time must not loop forever).
      for (const j of jobs) {
        if (j.status !== 'processing') continue;
        changed = true;
        if ((j.attempts ?? 0) < this.maxAttempts) {
          Object.assign(j, { status: 'queued', workerId: undefined, progress: 5, stepMessage: 'Re-queued: the server restarted while rendering it.', queuedAt: new Date().toISOString() });
        } else {
          Object.assign(j, { status: 'failed', workerId: undefined, error: 'Interrupted by server restart on every attempt', stepMessage: 'Interrupted by server restart — retry to run again.', completedAt: new Date().toISOString() });
        }
      }
      if (changed) writeJsonFileAtomic(this.jobsFile, jobs);
      this.reconcileCharges(jobs);
    } catch (err: any) {
      console.error(JSON.stringify({ level: 'error', event: 'job_recovery_skipped', error: String(err?.message || err) }));
    }
    return report;
  }

  /** F7 (JSON): charge every completed job that is not yet in its user's billedJobIds. Idempotent. */
  private reconcileCharges(jobs: ServerJob[]) {
    const subs = this.subs();
    const retained = new Set(jobs.map((j) => j.id));
    let changed = false;
    let charged = 0;
    for (const j of jobs) {
      if (j.status !== 'completed' || !(j.billedSeconds! > 0)) continue;
      const cur = subs[j.userId];
      if (cur?.billedJobIds?.includes(j.id)) continue;
      const base = cur || this.defaultsFor(j);
      subs[j.userId] = { ...base, monthlyRenderMinutesUsed: +((base.monthlyRenderMinutesUsed || 0) + j.billedSeconds! / 60).toFixed(2), billedJobIds: [...(base.billedJobIds || []), j.id] };
      changed = true;
      charged++;
    }
    // Ids of jobs no longer retained in jobs.json can never be reconciled again: drop them (bounded file size).
    for (const s of Object.values(subs)) {
      if (s.billedJobIds?.some((id) => !retained.has(id))) {
        s.billedJobIds = s.billedJobIds.filter((id) => retained.has(id));
        changed = true;
      }
    }
    if (changed) writeJsonFileAtomic(this.subsFile, subs);
    if (charged) console.warn(JSON.stringify({ level: 'warn', event: 'render_charges_reconciled', count: charged }));
  }
  private defaultsFor(j: ServerJob): StoredSubscription {
    return j.billingDefaults ?? { plan: 'free', status: 'active', monthlyRenderMinutesUsed: 0, currentPeriodEnd: new Date(Date.now() + 30 * 864e5).toISOString() };
  }

  async health() {
    let shared = true;
    try {
      readJsonFile(this.jobsFile, []);
      readJsonFile(this.subsFile, {});
    } catch {
      shared = false;
    }
    const projects = this.store.status();
    return { ok: shared && projects.available && this.ledger.available, detail: { projects, usageLedger: this.ledger.available ? 'ok' : 'unavailable', sharedStores: shared } };
  }

  async close() {
    this.ledger.flush();
  }

  // ---------- projects ----------
  async listProjects(userId: string) {
    return this.store.listByUser(userId);
  }
  async listAllProjects(limit: number) {
    const { projects, unreadableShards } = this.store.listAll();
    return { projects: projects.slice(0, limit), unreadable: unreadableShards };
  }
  async getProject(id: string) {
    const owner = this.store.ownerOf(id);
    if (!owner) return null;
    const project = this.store.get(id);
    return project ? { project, ownerId: owner } : null;
  }
  // Single process: the check and the write below run without an await in between, so they are atomic.
  async saveProject(userId: string, project: any, opts: SaveProjectOptions = {}) {
    const owner = this.store.ownerOf(project.id);
    if (owner && owner !== userId) throw new ProjectOwnershipError();
    if (opts.mustExist && !owner) throw new ProjectNotFoundError();
    this.store.put(userId, project);
  }
  async deleteProject(ownerId: string, id: string) {
    return this.store.delete(ownerId, id);
  }

  // ---------- subscriptions ----------
  private subs() {
    return readJsonFile<Record<string, StoredSubscription>>(this.subsFile, {});
  }
  async getSubscription(userId: string) {
    const s = this.subs()[userId];
    if (!s) return null;
    const { billedJobIds: _b, ...pub } = s;
    return pub;
  }
  async putSubscription(userId: string, sub: StoredSubscription) {
    const subs = this.subs();
    // billedJobIds is the exactly-once record of charges: a plan change or monthly reset must not erase it.
    subs[userId] = { ...sub, billedJobIds: subs[userId]?.billedJobIds };
    writeJsonFileAtomic(this.subsFile, subs);
  }
  async addRenderMinutes(userId: string, seconds: number, defaults: StoredSubscription) {
    const subs = this.subs();
    const cur = subs[userId] || defaults;
    subs[userId] = { ...cur, monthlyRenderMinutesUsed: +((cur.monthlyRenderMinutesUsed || 0) + seconds / 60).toFixed(2) };
    writeJsonFileAtomic(this.subsFile, subs);
  }

  // ---------- AI quota ----------
  async reserveAi(entries: QuotaEntry[], _day: number, reservationId: string) {
    return this.ledger.reserve([...entries].sort((a, b) => a.key.localeCompare(b.key)), reservationId);
  }
  async settleAi(reservationId: string, outcome: AiSettlement) {
    return this.ledger.settle(reservationId, outcome);
  }
  async expireAiReservations(ttlMs: number) {
    return this.ledger.expire(ttlMs);
  }
  async peekAi(key: string, _day: number) {
    return this.ledger.peek(key);
  }

  // ---------- rate limiting (in memory: single instance) ----------
  async takeRateTokens(list: Array<{ key: string; max: number }>) {
    const now = Date.now();
    const bs = list.map(({ key, max }) => {
      let b = this.buckets.get(key);
      if (!b) {
        b = { tokens: max, lastRefill: now };
        this.buckets.set(key, b);
      }
      b.tokens = Math.min(max, b.tokens + ((now - b.lastRefill) / 60000) * max);
      b.lastRefill = now;
      return b;
    });
    if (bs.some((b) => b.tokens < 1)) return { ok: false, remaining: 0 };
    for (const b of bs) b.tokens -= 1;
    return { ok: true, remaining: Math.floor(Math.min(...bs.map((b) => b.tokens))) };
  }
  async incrementWindow(key: string, windowId: number, limit: number) {
    let w = this.windows.get(key);
    if (!w || w.windowId !== windowId) {
      w = { windowId, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= limit) return { ok: false, count: w.count };
    w.count++;
    return { ok: true, count: w.count };
  }

  // ---------- guest registration protection (Track A) ----------
  async redeemOnce(key: string, ttlMs: number) {
    const now = Date.now();
    const until = this.redemptions.get(key);
    if (until !== undefined && until > now) return false;
    this.redemptions.set(key, now + ttlMs);
    return true;
  }
  async takeWindows(entries: WindowEntry[]) {
    for (const e of entries) {
      if ((this.limitWindows.get(`${e.key}@${e.windowId}`) ?? 0) + 1 > e.limit) return { ok: false as const, key: e.key };
    }
    for (const e of entries) {
      const k = `${e.key}@${e.windowId}`;
      this.limitWindows.set(k, (this.limitWindows.get(k) ?? 0) + 1);
    }
    return { ok: true as const };
  }
  async recordStat(key: string, windowId: number) {
    const k = `${key}@${windowId}`;
    const n = (this.stats.get(k) ?? 0) + 1;
    this.stats.set(k, n);
    return n;
  }
  async statsInWindow(prefix: string, windowId: number) {
    const out: Record<string, number> = {};
    for (const [k, n] of this.stats) {
      const at = k.lastIndexOf('@');
      if (k.startsWith(prefix) && Number(k.slice(at + 1)) === windowId) out[k.slice(prefix.length, at)] = n;
    }
    return out;
  }
  async statSeries(key: string, fromWindowId: number) {
    const out: Array<{ windowId: number; count: number }> = [];
    for (const [k, n] of this.stats) {
      const at = k.lastIndexOf('@');
      if (k.slice(0, at) === key && Number(k.slice(at + 1)) >= fromWindowId) out.push({ windowId: Number(k.slice(at + 1)), count: n });
    }
    return out.sort((a, b) => a.windowId - b.windowId);
  }

  // ---------- jobs ----------
  private jobs(): ServerJob[] {
    return readJsonFile<ServerJob[]>(this.jobsFile, []);
  }
  private writeJobs(jobs: ServerJob[]) {
    if (jobs.length > MAX_STORED_JOBS) jobs.length = MAX_STORED_JOBS;
    writeJsonFileAtomic(this.jobsFile, jobs);
  }
  private update(id: string, fn: (j: ServerJob) => boolean): ServerJob | null {
    const jobs = this.jobs();
    const j = jobs.find((x) => x.id === id);
    if (!j || !fn(j)) return null;
    this.writeJobs(jobs);
    return j;
  }
  async listJobs(userId: string, limit: number) {
    return this.jobs().filter((j) => j.userId === userId).slice(0, limit);
  }
  async getJob(id: string) {
    return this.jobs().find((j) => j.id === id) || null;
  }
  async activeJobs(userId: string) {
    return this.jobs().filter((j) => j.userId === userId && (j.status === 'queued' || j.status === 'processing'));
  }
  private static active(j: ServerJob) {
    return j.status === 'queued' || j.status === 'processing';
  }
  // Read-check-write with no await in between: atomic within this single process.
  async insertJob(job: ServerJob, admit?: JobAdmission): Promise<JobDenial | null> {
    const jobs = this.jobs();
    const denied = admit?.(jobs.filter((j) => j.userId === job.userId && JsonRepo.active(j)), { globalQueued: jobs.filter((j) => j.status === 'queued').length }) ?? null;
    if (denied) return denied;
    jobs.unshift({ ...job, attempts: 0, queuedAt: new Date().toISOString() });
    this.writeJobs(jobs);
    return null;
  }
  // Fair claim: least recently served user first (never-served first), FIFO within a user, per-user running cap.
  async claimNextJob(workerId: string, maxRunningPerUser = 1) {
    const jobs = this.jobs();
    const lastServed = new Map<string, number>();
    const running = new Map<string, number>();
    for (const j of jobs) {
      if (j.claimedAt) lastServed.set(j.userId, Math.max(lastServed.get(j.userId) ?? 0, Date.parse(j.claimedAt)));
      if (j.status === 'processing') running.set(j.userId, (running.get(j.userId) ?? 0) + 1);
    }
    // jobs are stored newest first; oldest first within a user
    const queued = [...jobs].reverse().filter((j) => j.status === 'queued' && (running.get(j.userId) ?? 0) < maxRunningPerUser);
    queued.sort((a, b) => (lastServed.get(a.userId) ?? -1) - (lastServed.get(b.userId) ?? -1) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const next = queued[0];
    if (!next) return null;
    Object.assign(next, { status: 'processing', workerId, progress: 20, stepMessage: 'Rendering...', attempts: (next.attempts ?? 0) + 1, claimedAt: new Date().toISOString() });
    this.writeJobs(jobs);
    this.heartbeats.set(next.id, Date.now());
    return { ...next };
  }
  async heartbeat(jobId: string, workerId: string, progress: number, stepMessage: string): Promise<HeartbeatResult> {
    const jobs = this.jobs();
    const j = jobs.find((x) => x.id === jobId);
    if (!j) return 'lost';
    if (j.status === 'cancelled') return 'cancelled';
    if (j.status !== 'processing' || j.workerId !== workerId) return 'lost';
    if (j.progress !== progress || j.stepMessage !== stepMessage) {
      Object.assign(j, { progress, stepMessage });
      this.writeJobs(jobs);
    }
    this.heartbeats.set(jobId, Date.now());
    return 'ok';
  }
  async finishJob(job: ServerJob, workerId: string) {
    this.heartbeats.delete(job.id);
    return Boolean(
      this.update(job.id, (j) => {
        if (j.status !== 'processing' || j.workerId !== workerId) return false;
        Object.assign(j, { ...job, workerId: undefined });
        return true;
      }),
    );
  }
  // Two writes, made exactly-once by reconciliation: (1) the job is completed WITH billedSeconds (the durable intent),
  // (2) the subscription is charged and records the job id. A crash after (1) is charged by init(); (2) never
  // charges a job id twice.
  async completeJob(job: ServerJob, workerId: string, billSeconds: number, defaults: StoredSubscription) {
    this.heartbeats.delete(job.id);
    const done = this.update(job.id, (j) => {
      if (j.status !== 'processing' || j.workerId !== workerId) return false;
      Object.assign(j, { ...job, status: 'completed', workerId: undefined, error: undefined, billedSeconds: billSeconds, billingDefaults: defaults });
      return true;
    });
    if (!done) return false;
    const subs = this.subs();
    const cur = subs[job.userId] || defaults;
    if (!cur.billedJobIds?.includes(job.id)) {
      subs[job.userId] = { ...cur, monthlyRenderMinutesUsed: +((cur.monthlyRenderMinutesUsed || 0) + billSeconds / 60).toFixed(2), billedJobIds: [...(cur.billedJobIds || []), job.id] };
      writeJsonFileAtomic(this.subsFile, subs);
    }
    return true;
  }
  async releaseJob(jobId: string, workerId: string) {
    this.heartbeats.delete(jobId);
    return Boolean(
      this.update(jobId, (j) => {
        if (j.status !== 'processing' || j.workerId !== workerId) return false;
        Object.assign(j, { status: 'queued', workerId: undefined, progress: 5, attempts: Math.max(0, (j.attempts ?? 1) - 1), stepMessage: 'Re-queued: the server rendering it was restarted.', queuedAt: new Date().toISOString() });
        return true;
      }),
    );
  }
  async cancelJob(jobId: string) {
    return this.update(jobId, (j) => {
      if (j.status !== 'queued' && j.status !== 'processing') return false;
      Object.assign(j, { status: 'cancelled', stepMessage: 'Job cancelled by user request.', completedAt: new Date().toISOString() });
      return true;
    });
  }
  async requeueJob(jobId: string, admit?: JobAdmission) {
    let denied = null as JobDenial | null;
    const all = this.jobs();
    const job = this.update(jobId, (j) => {
      if (j.status !== 'failed' && j.status !== 'cancelled') return false;
      denied = admit?.(all.filter((x) => x.userId === j.userId && x.id !== j.id && JsonRepo.active(x)), { globalQueued: all.filter((x) => x.status === 'queued').length }) ?? null;
      if (denied) return false;
      Object.assign(j, { status: 'queued', progress: 5, error: undefined, result: undefined, completedAt: undefined, workerId: undefined, attempts: 0, queuedAt: new Date().toISOString(), stepMessage: 'Re-queued for rendering...' });
      return true;
    });
    return denied ? { job: null, denied } : { job };
  }
  async reapStaleJobs(staleMs: number, maxAttempts: number): Promise<ReapResult> {
    // Single process: a processing job whose heartbeat stopped belongs to a hung render in this process.
    const now = Date.now();
    const stale = [...this.heartbeats].filter(([, t]) => now - t > staleMs).map(([id]) => id);
    const out = { requeued: 0, failed: 0 };
    for (const id of stale) {
      this.heartbeats.delete(id);
      this.update(id, (j) => {
        if (j.status !== 'processing') return false;
        if ((j.attempts ?? 0) < maxAttempts) {
          Object.assign(j, { status: 'queued', workerId: undefined, progress: 5, stepMessage: 'Re-queued: the render worker stopped responding.', queuedAt: new Date().toISOString() });
          out.requeued++;
        } else {
          Object.assign(j, { status: 'failed', workerId: undefined, error: 'Render worker stopped responding on every attempt', stepMessage: 'Failed: render worker stopped responding — retry to run again.', completedAt: new Date().toISOString() });
          out.failed++;
        }
        return true;
      });
    }
    return out;
  }
  async expireQueuedJobs(ttlMs: number) {
    const jobs = this.jobs();
    const cutoff = Date.now() - ttlMs;
    let n = 0;
    for (const j of jobs) {
      if (j.status === 'queued' && Date.parse(j.queuedAt || j.createdAt) < cutoff) {
        Object.assign(j, { status: 'failed', error: 'Expired: waited too long in the render queue', stepMessage: 'Expired: waited too long in the render queue — retry to queue it again.', completedAt: new Date().toISOString() });
        n++;
      }
    }
    if (n) this.writeJobs(jobs);
    return n;
  }

  async sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.lastRefill > 10 * 60000) this.buckets.delete(k);
    for (const [k, until] of this.redemptions) if (until <= now) this.redemptions.delete(k);
    const hour = Math.floor(now / 3600000);
    for (const k of this.limitWindows.keys()) if (Number(k.slice(k.lastIndexOf('@') + 1)) < hour - 48) this.limitWindows.delete(k);
    for (const k of this.stats.keys()) if (Number(k.slice(k.lastIndexOf('@') + 1)) < hour - STATS_RETENTION_WINDOWS) this.stats.delete(k);
  }
}
