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
}

export type AiSettlement = 'commit' | 'refund';

export interface QuotaEntry {
  key: string;
  limit: number;
}

export type HeartbeatResult = 'ok' | 'cancelled' | 'lost';
export type JobDenial = [number, Record<string, unknown>];
/** Synchronous predicate over the user's other active jobs; returns a denial or null. */
export type JobAdmission = (activeJobs: ServerJob[]) => JobDenial | null;

/** Thrown when a project id exists but belongs to someone else (callers answer 404). */
export class ProjectOwnershipError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectOwnershipError';
  }
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
  /** Insert or replace. Throws ProjectOwnershipError if the id belongs to another user, StoreLimitError on quota. */
  saveProject(userId: string, project: any): Promise<void>;
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
   * Settles a reservation exactly once: 'commit' keeps the charge, 'refund' returns it. Settling an already
   * settled (or unknown) reservation is a no-op, so retries can never double-refund.
   */
  settleAi(reservationId: string, outcome: AiSettlement): Promise<'settled' | 'already_settled'>;
  /** Refunds reservations left open longer than ttlMs (crashed request, failed settle). Returns how many. */
  expireAiReservations(ttlMs: number): Promise<number>;
  peekAi(key: string, day: number): Promise<number>;

  // ---- rate limiting (shared token buckets) ----
  /** Refills every bucket; consumes one token from each only if all have >= 1. */
  takeRateTokens(buckets: Array<{ key: string; max: number }>): Promise<{ ok: boolean; remaining: number }>;
  /** Fixed-window counter: increments only while count < limit. */
  incrementWindow(key: string, windowId: number, limit: number): Promise<{ ok: boolean; count: number }>;

  // ---- render jobs ----
  listJobs(userId: string, limit: number): Promise<ServerJob[]>;
  getJob(id: string): Promise<ServerJob | null>;
  activeJobs(userId: string): Promise<ServerJob[]>;
  /**
   * Inserts a job. When `admit` is given it is evaluated against the user's active jobs atomically with the
   * insert (no other job of this user can be admitted in between, on any instance); a non-null result is a
   * denial ([httpStatus, body]) and nothing is inserted.
   */
  insertJob(job: ServerJob, admit?: JobAdmission): Promise<JobDenial | null>;
  /** Atomically moves the oldest queued job to processing for this worker. */
  claimNextJob(workerId: string): Promise<ServerJob | null>;
  heartbeat(jobId: string, workerId: string, progress: number, stepMessage: string): Promise<HeartbeatResult>;
  /** Final state written only if this worker still owns the job (a cancel in between wins). */
  finishJob(job: ServerJob, workerId: string): Promise<boolean>;
  cancelJob(jobId: string): Promise<ServerJob | null>;
  /** Failed/cancelled -> queued, subject to `admit` (evaluated atomically, excluding this job). */
  requeueJob(jobId: string, admit?: JobAdmission): Promise<{ job: ServerJob | null; denied?: JobDenial }>;
  /** Marks processing jobs whose worker stopped heart-beating as failed. Returns how many. */
  reapStaleJobs(staleMs: number): Promise<number>;

  // ---- housekeeping (expired buckets/windows/old usage rows) ----
  sweep(): Promise<void>;
}
