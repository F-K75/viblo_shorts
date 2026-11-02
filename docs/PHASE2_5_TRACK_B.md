# Phase 2.5 Track B: render queue fairness, exactly-once billing, recovery (R-04, F7)

Status: **implemented on branch `claude/keen-feynman-xtbvz2-track-b`; awaiting separate review. Not merged.**
This document is evidence for review, not a release claim. Forge Studio remains **not release-ready**.

Exit criterion (owner): *no starvation, duplicate billing, lost refunds or abandoned jobs.*

## 1. Commits
| Commit | Content |
|---|---|
| `db07d8e` | docs: Track C merge recorded (accepted evidence, residual risks, follow-ups) |
| `d152f95` | **red** regression tests `tests/render_queue.test.ts` (written and run before any implementation) |
| `7328514` | implementation (server, both repos, migration `0003_render_queue.sql`, `.env.example`, API docs) |
| `86f27f1` | contract tests + intended updates of existing tests (see §5) |

## 2. Red-first evidence (on `main` @ `53fc724`, before the implementation)
`tests/render_queue.test.ts` (14 tests): **12 failed, 2 passed**.

| Test | Result on old code | What it showed |
|---|---|---|
| B2 guest render | fail: 200 | guests could start server renders |
| B3 1 running + 3 queued | fail | 5 jobs admitted, 2 processing at once for one user |
| B3 configurable cap | fail | `[200,200,200]` |
| B3 global cap, 2 instances | fail | every burst request admitted (no global cap) |
| B4 fairness | fail | B's job ran last (`a1,a2,a3,b1`): starvation |
| B5 charged exactly once | pass | billing of a normal completion was already correct |
| B5 PostgreSQL atomic | **fail: F7 reproduced** | job `completed` although its charge failed (completed-but-unbilled) |
| B5 JSON crash between completion and charge | fail | no exactly-once mechanism (`completeJob` missing) |
| B6 wall-clock timeout | fail | a 1 s limit was not enforced; job `completed` |
| B6 queue-wait expiry | fail | job still `processing`/queued, never expired |
| B7 SIGKILL, 2 instances | fail | job `failed` by the reaper, never completed elsewhere |
| B7 SIGTERM, 2 instances | fail | graceful shutdown marked the job `failed` |
| B7 bounded retries | fail | no attempt counting |
| B8 no paid-priority wording | pass | no such wording existed; the test guards it |

## 3. Design as implemented
| Control | Implementation | Default (env) |
|---|---|---|
| Guests | `403 sign_in_required` on `/api/render/video`, `/api/jobs/create`, `/api/jobs/:id/retry` (only `firebase` principals render). Guests keep projects and editing. The UI never calls server render, so no current guest flow changes. **No claim is made that browser export works.** | — |
| Per user | `active (queued + processing) < RUNNING + QUEUED`, evaluated atomically with the insert/requeue. Above it → `429 user_queue_full` + `Retry-After: 30` | `RENDER_MAX_RUNNING_PER_USER=1`, `RENDER_MAX_QUEUED_PER_USER=3` |
| Global queue | queued jobs across all users/instances `< RENDER_QUEUE_MAX`, else `429 queue_full` + `Retry-After: 60`. PostgreSQL: all admissions serialized by advisory lock `jobAdmission` (7_311_000_005), so the cap is exact across instances | `RENDER_QUEUE_MAX=200` |
| Fair claim | Candidates: users with queued jobs and fewer running jobs than the cap, **least recently served user first** (never served first), then oldest job; FIFO within a user. Each candidate is claimed in its own short transaction: lock the user row, re-check the running count, claim one job `FOR UPDATE SKIP LOCKED`. | per instance `MAX_CONCURRENT_RENDERS=2` |
| Exactly-once billing (F7) | **PostgreSQL:** `completeJob` = job → `completed` (only if this worker still owns it) **and** the minute charge in **one transaction**. A failed charge rolls the completion back; the worker then fails the job and deletes the file. **JSON:** the job is written `completed` with `billedSeconds`; the subscription is charged and records the job id in `billedJobIds`; `init()` charges every completed job whose id is missing (idempotent). | — |
| Timeout | ffmpeg is SIGKILLed after `clamp(FACTOR × duration, MIN, MAX)` s; job `failed` "Render timed out after N s"; not charged. Replaces the old fixed 120 s ceiling. | 3 ×, [60, 600] s |
| Queue-wait expiry | queued longer than TTL → `failed` "Expired: waited too long in the render queue"; not charged | `RENDER_QUEUE_TTL_S=1800` |
| Crash recovery | a claim counts an attempt. A stale heartbeat requeues the job while `attempts < max`, otherwise fails it. JSON: the same on start for jobs left `processing`. | `RENDER_MAX_ATTEMPTS=2`, `JOB_STALE_MS=30000` |
| Graceful shutdown | SIGTERM kills the encoders and **hands the jobs back to the queue** (`releaseJob`, attempt not counted) instead of failing them; another instance renders them | — |
| Synchronous route | `/api/render/video` no longer spawns ffmpeg outside the queue: it enqueues (same admission, fairness, timeout, billing), waits, returns the old response shape; after `RENDER_SYNC_WAIT_S` it answers `202 {jobId, pollUrl}` and the job continues; if the client disconnects first its job is cancelled (not charged) | `RENDER_SYNC_WAIT_S=50` (below a 60 s LB idle timeout) |
| Migration | `0003_render_queue.sql`: `attempts int NOT NULL DEFAULT 0`, `claimed_at`, `queued_at`, partial index `(user_id, status)` on active rows. Marked `forge:backward-compatible` and accepted by the expand-only validator; the previous release ignores the columns. | — |

Lock order (PostgreSQL): `jobAdmission` advisory lock → `users` row → `jobs` rows → `subscriptions` row. A claim
transaction holds at most one user lock and never waits on a job row (`SKIP LOCKED`), so claims cannot deadlock
with each other, with admissions or with completions.

### 3.1 Deviations from the approved plan (for the reviewer's decision)
1. **No `render_reservations` ledger (plan B5).** Nothing is charged until a render succeeds, and the charge is
   atomic with the completion. Cancel, timeout, failure, expiry and reaping therefore never charge, so there is
   **nothing to refund** and no refund can be lost or duplicated. Minutes of queued/running jobs are still counted at
   admission (FS-015), so a user cannot over-commit. Trade-off: no persistent per-job reservation record. If a
   ledger is wanted for future paid billing, it would be a separate change.
2. **Migration number and index.** `0003_render_queue.sql` (the next free number; the plan said `0004_jobs_fair_queue`),
   with a partial index `(user_id, status)` on active rows instead of `(status, user_id, created_at)`.
3. **Fairness rule.** "Least recently served user first" instead of "fewest running jobs, ties by oldest waiting".
   With the per-user running cap of 1 they order the same in every tested case (2 × and 3 × 3 matrices). It is not one
   SQL statement: one candidate query plus a short transaction per candidate (needed for the per-user cap under concurrency).
4. **Per-instance workers.** `MAX_CONCURRENT_RENDERS` (default 2, tied to the Track C memory budget) is kept instead
   of a new `RENDER_WORKERS = cpus/2`.
5. **Input limits** are unchanged and already stricter than planned (duration ≤ 60 s, ≤ 40 beats, ≤ 1080×1920).
6. **Sync route.** The plan did not say what `/api/render/video` should do; routing it through the queue was
   necessary, otherwise it would bypass every limit above.

## 4. Test evidence (this branch)
New/extended tests:
* `tests/render_queue.test.ts`: 16 tests (B2–B9). The 14 red tests are unchanged in intent. Strengthened after the
  implementation (not red-first, stated honestly): the global-cap burst went from 40 to **300** concurrent requests
  over 2 instances (cap 25 → exactly 25 admitted, 275 × `429 queue_full` with `Retry-After`, 25 rows in the DB);
  a zombie check after the timeout kill; a no-ffmpeg check for guests; B9 (sync route: 202 + job continues and is
  charged once; disconnect cancels, not charged, encoder stopped).
* `tests/repo_contract.test.ts` (JSON and PostgreSQL): fair claim / per-user cap / admission context / release /
  bounded reap / expiry; `completeJob` exactly-once (double completion refused, cancel wins); 3 users × 3 jobs
  round-robin `a1 b1 c1 a2 b2 c2 a3 b3 c3`; PostgreSQL: 20 concurrent claimers never exceed the per-user cap
  (exactly 4 claims for 4 users), 30 concurrent admissions with cap 7 → exactly 7.

Results (local, PostgreSQL 16, real ffmpeg): see §6, filled from the gate run.

## 5. Intended behaviour changes in existing tests
| Test | Change | Why |
|---|---|---|
| `api.test.ts` render engine + jobs | signed-in users instead of guests | guests now get 403 (B2) |
| `phase1.test.ts` corrupt `jobs.json` | signed-in user | otherwise 403 before the store is read |
| `phase1.test.ts` FS-015 retry cap | signed-in; fill 4 slots (was 5); assert `user_queue_full` | cap is 1 running + 3 queued |
| `phase1.test.ts` async route failure | signed-in user | the render route must reach the subscription read |
| `phase2.test.ts` atomic admission across instances | 12 concurrent creates → 4 accepted, 8 × 429 (was 5/7) | new per-user cap |
| `repo_contract.test.ts` FIFO claim / concurrent claims | explicit per-user cap (10 / 100) | the default cap is now 1; the original intent (FIFO, never the same job twice) is unchanged |
| reaper contract | `reapStaleJobs(staleMs, maxAttempts)` returns `{requeued, failed}` | bounded requeue instead of always failing |

No test was weakened: every changed assertion encodes the new, stricter rule.

## 6. Gate results
_Filled in below after the runs complete._

## 7. Residual risks (Track B, recorded, not solved)
1. **JSON backend: under-count window after a crash.** A crash between the completion and the charge is charged at
   the next start, not immediately. The single-instance JSON mode cannot do better without a transaction. PostgreSQL
   (the production target) has no such window.
2. **Orphaned ffmpeg after a hard crash (SIGKILL/OOM of Node only).** The child encoder keeps running until it ends
   (≤ 60 s video at `ultrafast`); its timeout timer died with the process. In a container a crash of PID 1 kills the
   whole container, so this mainly affects bare-metal/dev runs. Its file is swept by `RENDER_TTL_HOURS`.
3. **Charge basis is the requested duration** (normalised, ≤ 60 s), not the measured output duration (unchanged).
4. **A graceful shutdown longer than the 10 s hard-exit timer** falls back to the reaper, which counts an attempt.
5. **Sync route behind a proxy:** if `RENDER_SYNC_WAIT_S` is set above the load balancer idle timeout, the proxy
   cuts the connection and the job is cancelled as abandoned. The default is 50 s; the setting is documented.
6. **Scale of the fair-claim query** (`max(claimed_at)` per candidate user) is only proven up to the tested load
   (300 admissions, 200-job queue cap). Not load-tested at production queue sizes.
7. **No per-plan scheduling classes** (by design: no paid priority until billing exists).
8. **Not covered by Track B:** Docker-level tests (Track D), live Gemini (R-01, Track E), browser export (unverified).
