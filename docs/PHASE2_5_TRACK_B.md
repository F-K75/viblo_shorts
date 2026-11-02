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

## 6. Gate results (local: PostgreSQL 16, real ffmpeg)
**Code under test: `5ea2030`.** The docs-only commit `ba1f91f` (parent `5ea2030`) changes 3 files under `docs/` and
nothing else. The SHA-256 of `git ls-tree -r` excluding `docs/` is identical for both commits
(`b633b3e6…97d`), so runs labelled `ba1f91f` exercised exactly the code at `5ea2030`.

New tests, three consecutive runs per backend (`render_queue` + `repo_contract`), one uninterrupted sequence, no retries:

| Run | Backend | Label | Tests | Pass | Fail | Skipped | Duration |
|---|---|---|---|---|---|---|---|
| 1 | JSON | `5ea2030` | 43 | 43 | 0 | 0 | 65.2 s |
| 2 | JSON | `ba1f91f` | 43 | 43 | 0 | 0 | 64.4 s |
| 3 | JSON | `ba1f91f` | 43 | 43 | 0 | 0 | 64.3 s |
| 1 | PostgreSQL | `ba1f91f` | 43 | 43 | 0 | 0 | 68.0 s |
| 2 | PostgreSQL | `ba1f91f` | 43 | 43 | 0 | 0 | 67.9 s |
| 3 | PostgreSQL | `ba1f91f` | 43 | 43 | 0 | 0 | 67.9 s |

Full suites (regression safety), same sequence:

| Backend | Tests | Pass | Fail | Cancelled | Skipped | Duration |
|---|---|---|---|---|---|---|
| JSON | 216 | 214 | 0 | 0 | 2 | 121.6 s |
| PostgreSQL | 216 | 207 | 0 | 0 | 9 | 130.1 s |

Skips: 2 live Gemini tests on both backends (`GEMINI_API_KEY` not set, logged "NOT passed"; R-01, Track E), plus 7
JSON-backend-specific tests on the PostgreSQL run (file corruption / volume snapshots). There were no other skips.

Earlier failures, recorded and not hidden:
* **B9 sync-route test (first gate attempt, `86f27f1`):** expected 202 after a 1 s wait, but a 6 s render can finish
  within it. Reproduced 2 of 3 in isolation. Fixed in the **test** (a blocker job holds the only slot), commit
  `5ea2030`, 5 of 5 after the fix. The sequence above started after this fix.
* **EPIPE in the Track C exit-criterion test** (one pre-fix full run): the known Track D test-helper item, not
  Track B. It did not recur in the full suites above.

### 6.1 CI (PR #5)
**Run 28 on `36a10fd` (code `5ea2030`): FAILED in the `test` job.** The JSON-suite step failed: 216 tests, 213 pass,
**1 fail**, 2 skipped.
* Failure: `B3 global queue cap … 300 users`, `27 !== 25`.
* Every later step and the `docker` job were skipped, so this run is no evidence for them.

Root cause (a test-premise error, not a server defect):
* The two 60 s "blocker" renders, meant to keep both workers busy for the whole burst, finish in seconds on a fast
  runner (7 s locally on 4 cores).
* Each freed worker then claimed a burst job. That **correctly** freed a queue slot (the cap limits *queued* jobs).
* Hence 25 + 2 = 27.
* **Reproduced locally**, `27 !== 25`, by running the old test with 2 s blockers.

The same hidden assumption ("a real render outlasts the test") made other tests timing-dependent:
* B3 per-user and configurable caps;
* B6 queue expiry;
* B9 disconnect;
* B7 crash and deploy, which could even pass **without any recovery happening**, if instance A finished the job
  before it was stopped.

**Fix (`8ac7235`, test-only):**
* A stub `ffmpeg` on `PATH` answers `-version` and otherwise sleeps until killed. The server's spawn, kill and timeout
  code is unchanged.
* It is used wherever the premise is "this slot stays busy" or "this instance cannot finish the job".
* The global-cap test keeps its **exact** assertion and now also asserts that only the two blockers are running.
* B7 gives the stub only to instance A, so `completed` proves instance B rendered the job.
* No assertion was weakened, and no test was skipped or retried to get green.

**Local, code `8ac7235`, 3 consecutive runs per backend** (`render_queue` + `repo_contract`), no retries:

| Backend | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| JSON | 43/43 (62.0 s) | 43/43 (61.5 s) | 43/43 (60.7 s) |
| PostgreSQL | 43/43 (64.4 s) | 43/43 (62.9 s) | 43/43 (63.5 s) |

**Run 29 on `8ac7235`: GREEN. Every job's log was read:**

| Job / step | Result (from the log) |
|---|---|
| `test`: typecheck | pass |
| `test`: JSON suite | 216 tests, 214 pass, 0 fail, 0 cancelled, 2 skipped (live Gemini) |
| `test`: every server on PostgreSQL | 216 tests, 207 pass, 0 fail, 0 cancelled, 9 skipped (2 live Gemini + 7 JSON-only) |
| `test`: all Track B tests (B2–B9 and the repo contracts) | `ok` in both suites |
| `test`: production build | pass |
| `test`: Playwright E2E, JSON and PostgreSQL | 1/1 and 1/1 |
| `test`: `bun audit --audit-level=high` | "No vulnerabilities found (checked 389 packages, 2 below --audit-level=high, 1 ignored)" |
| `docker`: app and backup images build | pass |
| `docker`: 2-instance PostgreSQL smoke | pass (readiness incl. `memory`, cross-instance project, health token) |
| `docker`: JSON smoke, unsafe-config refusal, backup tools | pass |
| `live-llm` | skipped on PRs by design (R-01 still open, Track E) |

Observation, not a gate:
* The E2E step's transient `npm install --no-save playwright@1` prints "5 vulnerabilities (1 moderate, 4 high)" from
  npm's own audit of that throwaway install tree.
* This PR changes no dependency, lockfile or workflow file (`git diff origin/main...HEAD` over `package.json`, lockfiles
  and `.github` is empty).
* The gating audit (`bun audit`) passes.
* Recorded for Track D, not fixed here.

Side effect of the B7 crash test: the SIGKILLed instance leaves its stub `sleep 300` orphaned, exactly as a real hard
crash orphans ffmpeg (residual risk 2). The orphan exits on its own after 5 minutes.

## 7. Risk register (Track B; owner assessment of 2026-11-02 recorded)
| # | Risk | Status after review verification | Owner assessment |
|---|---|---|---|
| 1 | **JSON backend: a crash between completion and charge is charged at the next start, not immediately** | Durability and idempotency now evidenced (§8.2): the charge intent (`billedSeconds`) is written with the completion (temp file + `fsync` + rename + directory `fsync`); reconciliation is idempotent across repeated restarts, survives its own crash, and survives a monthly reset. Remaining: usage is under-counted **until the restart**; JSON is single-instance and not the production target. | Needed explicit evidence (provided) |
| 2 | **Orphaned ffmpeg after a hard kill of Node only** | Conditions and mitigation documented (§8.5). In the shipped container Node is not PID 1 (`tini` is); Node's death ends the container and every process in it. **Not tested at Docker level** (Track D). Bare-metal/dev: orphan runs until its render ends (bounded by the 60 s maximum video length). | Operational risk; documented |
| 3 | **Charge basis is the requested duration** (normalised to 2–60 s), not the measured output | Made explicit in the API contract (`docs/API_INVENTORY.md`, "Server rendering contract") | Accepted |
| 4 | A graceful shutdown longer than the 10 s hard-exit timer falls back to the reaper, which counts an attempt | unchanged | (not raised) |
| 5 | Sync route: `RENDER_SYNC_WAIT_S` above the load balancer idle timeout makes the proxy's cut look like an abandoned client → job cancelled | Contract documented; default 50 s | (not raised) |
| 6 | Fair-claim query scale (`max(claimed_at)` per candidate user) proven only to the tested load (300 admissions, 200-job cap) | unchanged | Accepted as a known scalability limitation |
| 7 | **`MAX_CONCURRENT_RENDERS` is per instance**: aggregate = instances × limit (3 × 2 = 6) | Documented in `.env.example`, API contract and §8.4 | Accepted with explicit awareness |
| 8 | No per-plan scheduling classes | by design (no paid priority until billing exists) | — |
| 9 | Live Gemini still skipped | **R-01 release blocker** (Track E) | Release blocker |
| 10 | Docker-level coverage of Track C (and the container claim in #2) | Track D | Track D follow-up |
| 11 | Browser export unverified | Track E | — |

## 8. Owner review verification (2026-11-02)
The owner approved the five decisions in §3.1, subject to the verification below. **This is not merge approval.**

### 8.1 Migration `0003`
| Check | Evidence |
|---|---|
| next unused version | `main` @ `53fc724` has only `0001_initial.sql`, `0002_ai_reservations.sql` |
| registry order | `loadMigrations`: `1:0001_initial`, `2:0002_ai_reservations`, `3:0003_render_queue` (only 0003 marked backward-compatible; the expand-only validator accepts it) |
| upgrade path (real PostgreSQL) | a database migrated as `main` (`current: 2`) → branch applies **only** `0003_render_queue.sql` (`current: 3`); re-run applies nothing |
| rollback compatibility | the previous release (migrations 1–2) against the v3 schema: `applied: []`, logs `schema_newer_than_build` with `newerCompatible: ["0003_render_queue.sql"]`, and runs |
| production container (CI run 30, `docker` job) | `{"event":"schema_migrated","applied":["0001_initial.sql","0002_ai_reservations.sql","0003_render_queue.sql"],"version":3}` |

### 8.2 Billing correctness (condition A)
| Requirement | Evidence (test) |
|---|---|
| PostgreSQL completion + charge atomic | B5 "PostgreSQL: if the charge cannot be written, the job is NOT marked completed" (charge failure injected by trigger); **P1** (new): the instance is SIGKILLed while blocked *inside* the completion+charge transaction, after the job row was already updated; the transaction rolls back as a unit (job not `completed`, no subscription row), the other instance's reaper requeues it, it is rendered again and charged **exactly once** (`attempts = 2`, 0.1 min for 6 s). On the pre-Track-B code this test cannot pass: the completion was committed before the charge. |
| No double charge on duplicate completion / retry / recovery | contract (both backends, new): a stale worker that finishes after its job was reassigned is refused; a retried completion is refused; a completed job cannot be retried; PostgreSQL (new): 10 concurrent completions of one job commit exactly one charge; J4: repeated restarts never re-charge |
| Failed and cancelled never charged | contract "failed jobs are never charged"; J6: failed, cancelled (render finishing after the cancel) and expired, across restarts; B5 (cancel), B6 (timeout, expiry), B9 (client disconnect) at HTTP level |
| Crash recovery cannot lose a successful charge | P1 (PostgreSQL); JSON: B5 crash between completion and charge → charged once on restart; **J1** crash while writing the completion → not completed, not charged, requeued, then charged once; **J3** crash while the restart reconciles → next restart charges once; **J5** a monthly reset after the charge is not undone or repeated by reconciliation |
| JSON durability | every write is `writeJsonFileAtomic`: temp file, `fsync`, `rename`, directory `fsync` (`server/lib/storage.ts`) |

### 8.3 Queue and API contract (conditions B, C)
* **Fairness, multiple users and repeated scheduling:**
  * 3 users × 3 jobs → `a1 b1 c1 a2 b2 c2 a3 b3 c3` (three full rounds, both backends);
  * a late joiner is served second, not last (B4, HTTP);
  * per-user running cap under 20 concurrent claimers (PostgreSQL).
* **Synchronous endpoint:** the contract is written in `docs/API_INVENTORY.md` ("Server rendering contract"):
  * `RENDER_SYNC_WAIT_S` (50 s) is how long the **request waits**, not an execution timeout;
  * `202` + `jobId` + `pollUrl` when the wait ends, and the job continues;
  * a client disconnect before any response cancels the job, uncharged;
  * after a 202 the client may disconnect freely;
  * the job's status is read with `GET /api/jobs/:id`;
  * tested by B9 (202 and continue; disconnect cancels and stops the encoder).
* **No bypass:**
  * S1 (new) asserts that `renderVideoWithFfmpeg` has exactly one caller, `executeRenderJob` (the queue worker);
  * ffmpeg is spawned only there and by the `-version` readiness probe;
  * no other server module spawns ffmpeg;
  * the HTTP render routes all enqueue.

### 8.4 Concurrency (condition B)
`MAX_CONCURRENT_RENDERS` limits renders **per instance**. Deployment-wide concurrency is instances ×
`MAX_CONCURRENT_RENDERS` (3 × 2 = 6). The global **queue** cap (`RENDER_QUEUE_MAX`) and the per-user caps are
deployment-wide (enforced in PostgreSQL). Documented in `.env.example` and the API contract.

### 8.5 Orphaned ffmpeg (operational)
**When it happens:** only when the Node process dies *without running its shutdown code* (SIGKILL, kernel OOM kill
of Node, a native crash) while an encoder runs. A normal stop (SIGTERM/SIGINT) kills encoders and hands their jobs
back to the queue. The orphan keeps encoding until its render ends (≤ 60 s of video). Its timeout timer died with Node.
Its output is never registered and is removed by the `RENDER_TTL_HOURS` sweep. The job itself is recovered by another
instance (B7, P1), so the only cost is wasted CPU and memory for the orphan's lifetime.

**Mitigation as shipped:**
* the image runs `tini` as PID 1 with Node as its child;
* when Node dies, `tini` exits, the container stops, and the kernel kills every remaining process in the container's
  PID namespace, including orphaned encoders;
* this is the documented semantics of a PID namespace whose init exits. **It has not been tested at Docker level**
  (recorded for Track D).

**Mitigation outside containers:** run under a supervisor that kills the whole process group or cgroup on exit
(e.g. systemd `KillMode=control-group`, the default). Do not run Node bare with a restart loop that leaves the
group alive.

### 8.6 Requested-duration billing
Explicit in the API contract: the charge is the requested (normalised) video duration, not the measured output.
The UI shows minutes used / limit from `/api/user/subscription`.

### 8.7 CI on documentation commit `7946e8b` (run 30)
`head_sha` = `7946e8b` = the branch head at that time. That commit changed only `docs/`, so the code tested was `8ac7235`.
Every job's log was read:

| Job / step | Result |
|---|---|
| `test`: typecheck | pass |
| `test`: JSON suite | 216 tests, 214 pass, 0 fail, 0 cancelled, 2 skipped (live Gemini) |
| `test`: every server on PostgreSQL | 216 tests, 207 pass, 0 fail, 0 cancelled, 9 skipped (2 live Gemini + 7 JSON-only) |
| `test`: build | pass |
| `test`: E2E | JSON 1/1, PostgreSQL 1/1 |
| `test`: `bun audit` | "No vulnerabilities found" |
| `docker` | both images built; 2-instance PostgreSQL smoke (migrations 1–3 applied, readiness incl. `memory`); JSON smoke + backup CLI; unsafe production config refused (exit 1 ×2); backup tools present |
| `live-llm` | skipped on PRs (R-01) |

The run 28 failure and its test-only correction remain recorded in §6.1. Results for the final head (after the
verification commits) are in §8.8.

### 8.8 Final head
Results for this commit (the local gate: 3 consecutive runs of the new tests per backend plus both full suites, and
its CI run) are recorded in the PR #5 description, not in a later commit. That way the CI run reported is the run of
the exact final head.
