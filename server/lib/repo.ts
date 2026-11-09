// Storage abstraction (ADR-003). The API layer talks only to `Repo`; two implementations:
//  * JsonRepo     — Phase 1 per-user JSON shards (single instance; dev/test default and rollback target)
//  * PostgresRepo — production: transactional, multi-instance safe
// Both must pass the same contract tests (tests/repo_contract.test.ts).

export type PlanId = 'free' | 'pro' | 'studio';

export interface StoredSubscription {
  plan: PlanId;
  status: 'active';
  monthlyRenderMinutesUsed: number;
  currentPeriodEnd: string;
  demo?: boolean;
  /** JSON backend only: completed jobs already charged (makes the charge idempotent across a crash). */
  billedJobIds?: string[];
}

export interface ServerJob {
  id: string;
  userId: string;
  type: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stepMessage?: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
  result?: any;
  payload?: any;
  workerId?: string;
  /** How many times a worker claimed this job (crash recovery gives up after RENDER_MAX_ATTEMPTS). */
  attempts?: number;
  /** When the job (re-)entered the queue; jobs waiting longer than RENDER_QUEUE_TTL_S expire. */
  queuedAt?: string;
  /** When a worker last claimed it (fairness: the least recently served user goes first). */
  claimedAt?: string;
  /** JSON backend: render seconds charged for this completed job (exactly-once reconciliation on start). */
  billedSeconds?: number;
  /** JSON backend: the subscription to create if the user has none when the charge is reconciled. */
  billingDefaults?: StoredSubscription;
}

/**
 * How a reservation is settled (review R2, owner decision 2026-11-09):
 *  * usage:  what the server always uses. Charged iff an attempt was billable, uncertain or is still open (or the row
 *            was started by the previous release); otherwise refunded. A recorded start alone does not decide it.
 *  * commit / refund: explicit outcomes for repository callers and maintenance; the request path does not use them.
 */
export type AiSettlement = 'commit' | 'refund' | 'usage';
/**
 * Outcome of one provider attempt: 'yes' = the provider reported usage > 0 (billable even if the output was unusable);
 * 'no' = the provider answered with an error, or reported 0 usage; 'uncertain' = unknown (timeout, network error, no
 * usage metadata), charged.
 */
export interface AiAttemptResult {
  billable: 'yes' | 'no' | 'uncertain';
  /** Provider-reported total tokens of this attempt (0 when unknown or not billable). */
  tokens: number;
}

export interface QuotaEntry {
  key: string;
  limit: number;
}

export interface WindowEntry {
  key: string;
  windowId: number;
  limit: number;
}
/** Statistics keys ('stats:*') are kept 30 days of hourly windows (the guest-mint baseline). */
export const STATS_RETENTION_WINDOWS = 30 * 24;

export type HeartbeatResult = 'ok' | 'cancelled' | 'lost';
export type JobDenial = [number, Record<string, unknown>];
/** What the admission rule sees besides the user's own active jobs (counted atomically with the insert). */
export interface AdmissionContext {
  /** Jobs waiting in the queue across all users and instances (processing jobs are not counted). */
  globalQueued: number;
}
/** Synchronous predicate over the user's other active jobs; returns a denial or null. */
export type JobAdmission = (activeJobs: ServerJob[], ctx: AdmissionContext) => JobDenial | null;
/** Outcome of a crash-recovery pass: stale jobs either go back to the queue or, after too many attempts, fail. */
export interface ReapResult {
  requeued: number;
  failed: number;
}

/** Thrown when a project id exists but belongs to someone else (callers answer 404). */
export class ProjectOwnershipError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectOwnershipError';
  }
}

/** Thrown by saveProject({ mustExist: true }) when the project no longer exists (callers answer 404, as for ownership). */
export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectNotFoundError';
  }
}
export interface SaveProjectOptions {
  /** The caller is updating a project it read before: refuse (ProjectNotFoundError) instead of re-creating it if it
   *  was deleted in the meantime (F8). */
  mustExist?: boolean;
}

export type UserKind = 'firebase' | 'guest' | 'legacy';
export function userKindOf(userId: string): UserKind {
  if (userId.startsWith('guest_')) return 'guest';
  if (userId === '__legacy_unowned__' || userId === 'default_user' || userId === 'system') return 'legacy';
  return 'firebase';
}

export interface Repo {
  readonly kind: 'json' | 'postgres';
  health(): Promise<{ ok: boolean; detail: Record<string, unknown> }>;
  close(): Promise<void>;

  // ---- projects (quotas enforced atomically inside saveProject) ----
  listProjects(userId: string): Promise<any[]>;
  listAllProjects(limit: number): Promise<{ projects: any[]; unreadable: number }>;
  getProject(id: string): Promise<{ project: any; ownerId: string } | null>;
  /**
   * Insert or replace. Throws ProjectOwnershipError if the id belongs to another user (enforced inside the write itself,
   * also under concurrency), ProjectNotFoundError if opts.mustExist and the project is gone, StoreLimitError on quota.
   */
  saveProject(userId: string, project: any, opts?: SaveProjectOptions): Promise<void>;
  deleteProject(ownerId: string, id: string): Promise<boolean>;

  // ---- subscriptions ----
  getSubscription(userId: string): Promise<StoredSubscription | null>;
  putSubscription(userId: string, sub: StoredSubscription): Promise<void>;
  addRenderMinutes(userId: string, seconds: number, defaults: StoredSubscription): Promise<void>;

  // ---- daily AI quota (atomic all-or-nothing reservation across instances) ----
  /**
   * Reserves one unit on every key, all or nothing, under a caller-generated reservation id. Idempotent per id: a
   * retried reserve with the same id never charges twice.
   */
  reserveAi(entries: QuotaEntry[], day: number, reservationId: string): Promise<{ ok: true } | { ok: false; key: string }>;
  /**
   * Settles a reservation exactly once ('usage', or explicit 'commit' / 'refund'; see AiSettlement). Settling an
   * already settled (or unknown) reservation is a no-op, so retries can never double-refund.
   */
  settleAi(reservationId: string, outcome: AiSettlement): Promise<'settled' | 'already_settled'>;
  /**
   * Durably records that a provider attempt begins (review R1/R2), BEFORE the provider is called. Only while the
   * reservation is open; false means the attempt must NOT be made (already settled).
   */
  beginAiAttempt(reservationId: string): Promise<boolean>;
  /** Records the outcome of an attempt begun with beginAiAttempt. Accounting only; never changes a settled charge. */
  endAiAttempt(reservationId: string, result: AiAttemptResult): Promise<void>;
  /**
   * Settles reservations left open longer than ttlMs (crashed request, failed settle) by usage: an attempt still open
   * at the crash, or one with an unknown outcome, is charged; no attempt or only non-billable ones are refunded.
   * Returns how many were settled.
   */
  expireAiReservations(ttlMs: number): Promise<number>;
  peekAi(key: string, day: number): Promise<number>;

  // ---- rate limiting (shared token buckets) ----
  /** Refills every bucket; consumes one token from each only if all have >= 1. */
  takeRateTokens(buckets: Array<{ key: string; max: number }>): Promise<{ ok: boolean; remaining: number }>;
  /** Fixed-window counter: increments only while count < limit. */
  incrementWindow(key: string, windowId: number, limit: number): Promise<{ ok: boolean; count: number }>;

  // ---- guest registration protection (Track A) ----
  /**
   * Records `key` as used for ttlMs. True only for the first redemption while unexpired, on any instance (single-use
   * CAPTCHA tokens; the key is a hash, never the token).
   */
  redeemOnce(key: string, ttlMs: number): Promise<boolean>;
  /**
   * Fixed-window counters, all or nothing: increments every entry only if each stays within its limit; otherwise
   * nothing changes and the first exhausted key is returned. Atomic across instances.
   */
  takeWindows(entries: WindowEntry[]): Promise<{ ok: true } | { ok: false; key: string }>;
  /** Statistics counter (no limit) for `key` in `windowId`; returns the new count. Kept STATS_RETENTION_WINDOWS. */
  recordStat(key: string, windowId: number): Promise<number>;
  /** All statistics counters whose key starts with `prefix` in one window, as { suffix: count }. */
  statsInWindow(prefix: string, windowId: number): Promise<Record<string, number>>;
  /** One statistics key's counts for windows >= fromWindowId, oldest first. */
  statSeries(key: string, fromWindowId: number): Promise<Array<{ windowId: number; count: number }>>;

  // ---- render jobs ----
  listJobs(userId: string, limit: number): Promise<ServerJob[]>;
  getJob(id: string): Promise<ServerJob | null>;
  activeJobs(userId: string): Promise<ServerJob[]>;
  /**
   * Inserts a job. When `admit` is given it is evaluated against the user's active jobs and the global queue length
   * atomically with the insert (no other job can be admitted in between, on any instance); a non-null result is a
   * denial ([httpStatus, body]) and nothing is inserted.
   */
  insertJob(job: ServerJob, admit?: JobAdmission): Promise<JobDenial | null>;
  /**
   * Atomically claims one queued job for this worker (attempts + 1). Fair: the queued job of the user served least
   * recently goes first (FIFO within a user), and a user who already has `maxRunningPerUser` processing jobs is
   * skipped, so one user's backlog can never starve the others.
   */
  claimNextJob(workerId: string, maxRunningPerUser?: number): Promise<ServerJob | null>;
  heartbeat(jobId: string, workerId: string, progress: number, stepMessage: string): Promise<HeartbeatResult>;
  /** Final state written only if this worker still owns the job (a cancel in between wins). Never used for success. */
  finishJob(job: ServerJob, workerId: string): Promise<boolean>;
  /**
   * F7: marks the job completed AND charges `billSeconds` render seconds exactly once. PostgreSQL: one transaction,
   * so a completed-but-unbilled job is impossible. JSON: the job records `billedSeconds`; the subscription records
   * the job id; init() charges any completed job whose id is missing (a crash between the two writes).
   * Returns false (nothing charged) if this worker no longer owns the job, e.g. it was cancelled. Throws if the
   * charge cannot be written; the job is then not completed (PostgreSQL) or is reconciled on restart (JSON).
   */
  completeJob(job: ServerJob, workerId: string, billSeconds: number, defaults: StoredSubscription): Promise<boolean>;
  /** Graceful shutdown: hands a processing job back to the queue (the attempt is not counted). */
  releaseJob(jobId: string, workerId: string): Promise<boolean>;
  cancelJob(jobId: string): Promise<ServerJob | null>;
  /** Failed/cancelled -> queued, subject to `admit` (evaluated atomically, excluding this job). Resets attempts. */
  requeueJob(jobId: string, admit?: JobAdmission): Promise<{ job: ServerJob | null; denied?: JobDenial }>;
  /** Processing jobs whose worker stopped heart-beating go back to the queue, or fail once attempts >= maxAttempts. */
  reapStaleJobs(staleMs: number, maxAttempts: number): Promise<ReapResult>;
  /** Fails queued jobs that waited longer than ttlMs (never charged). Returns how many. */
  expireQueuedJobs(ttlMs: number): Promise<number>;

  // ---- housekeeping (expired buckets/windows/old usage rows) ----
  sweep(): Promise<void>;
}
