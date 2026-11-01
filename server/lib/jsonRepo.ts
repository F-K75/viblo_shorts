// JSON-file Repo (Phase 1 storage, single instance). Kept as the development default and as the
// rollback target of the PostgreSQL migration. Behaviour is unchanged from Phase 1.
import path from 'path';
import { ProjectStore, type StoreLimits } from './projectStore.ts';
import { readJsonFile, writeJsonFileAtomic } from './storage.ts';
import { UsageLedger } from './usage.ts';
import { ProjectOwnershipError, type HeartbeatResult, type JobAdmission, type JobDenial, type QuotaEntry, type Repo, type ServerJob, type StoredSubscription } from './repo.ts';

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

  constructor(dataDir: string, backupDir: string, limits: StoreLimits, ledgerFlushMs: number) {
    this.store = new ProjectStore(dataDir, backupDir, limits);
    this.ledger = new UsageLedger(path.join(dataDir, 'usage.json'), ledgerFlushMs);
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.subsFile = path.join(dataDir, 'subscriptions.json');
  }

  /** Runs the Phase 1 store init (incl. legacy migration) and marks jobs orphaned by a previous process. */
  init() {
    const report = this.store.init();
    try {
      const jobs = this.jobs();
      let changed = false;
      // Single instance: a job left "processing" by a previous process has no live worker. Queued jobs stay
      // queued and are picked up by this process's worker loop.
      for (const j of jobs) {
        if (j.status === 'processing') {
          Object.assign(j, { status: 'failed', error: 'Interrupted by server restart', stepMessage: 'Interrupted by server restart — retry to run again.', workerId: undefined });
          changed = true;
        }
      }
      if (changed) writeJsonFileAtomic(this.jobsFile, jobs);
    } catch (err: any) {
      console.error(JSON.stringify({ level: 'error', event: 'job_recovery_skipped', error: String(err?.message || err) }));
    }
    return report;
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
  async saveProject(userId: string, project: any) {
    const owner = this.store.ownerOf(project.id);
    if (owner && owner !== userId) throw new ProjectOwnershipError();
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
    return this.subs()[userId] || null;
  }
  async putSubscription(userId: string, sub: StoredSubscription) {
    const subs = this.subs();
    subs[userId] = sub;
    writeJsonFileAtomic(this.subsFile, subs);
  }
  async addRenderMinutes(userId: string, seconds: number, defaults: StoredSubscription) {
    const subs = this.subs();
    const cur = subs[userId] || defaults;
    subs[userId] = { ...cur, monthlyRenderMinutesUsed: +((cur.monthlyRenderMinutesUsed || 0) + seconds / 60).toFixed(2) };
    writeJsonFileAtomic(this.subsFile, subs);
  }

  // ---------- AI quota ----------
  async reserveAi(entries: QuotaEntry[], _day: number) {
    return this.ledger.reserve(entries);
  }
  async refundAi(keys: string[], day: number) {
    this.ledger.refund(keys, day);
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
  // Read-check-write with no await in between: atomic within this single process.
  async insertJob(job: ServerJob, admit?: JobAdmission): Promise<JobDenial | null> {
    const jobs = this.jobs();
    const denied = admit?.(jobs.filter((j) => j.userId === job.userId && (j.status === 'queued' || j.status === 'processing'))) ?? null;
    if (denied) return denied;
    jobs.unshift(job);
    this.writeJobs(jobs);
    return null;
  }
  async claimNextJob(workerId: string) {
    const jobs = this.jobs();
    // jobs are stored newest first; the queue is FIFO
    const next = [...jobs].reverse().find((j) => j.status === 'queued');
    if (!next) return null;
    Object.assign(next, { status: 'processing', workerId, progress: 20, stepMessage: 'Rendering...' });
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
      denied = admit?.(all.filter((x) => x.userId === j.userId && x.id !== j.id && (x.status === 'queued' || x.status === 'processing'))) ?? null;
      if (denied) return false;
      Object.assign(j, { status: 'queued', progress: 5, error: undefined, result: undefined, completedAt: undefined, workerId: undefined, stepMessage: 'Re-queued for rendering...' });
      return true;
    });
    return denied ? { job: null, denied } : { job };
  }
  async reapStaleJobs(staleMs: number) {
    // Single process: a processing job whose heartbeat stopped belongs to a crashed render in this process.
    const now = Date.now();
    const stale = [...this.heartbeats].filter(([, t]) => now - t > staleMs).map(([id]) => id);
    let n = 0;
    for (const id of stale) {
      this.heartbeats.delete(id);
      if (this.update(id, (j) => {
        if (j.status !== 'processing') return false;
        Object.assign(j, { status: 'failed', error: 'Render worker stopped responding', stepMessage: 'Failed: render worker stopped responding — retry to run again.', completedAt: new Date().toISOString() });
        return true;
      })) n++;
    }
    return n;
  }

  async sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.lastRefill > 10 * 60000) this.buckets.delete(k);
  }
}
