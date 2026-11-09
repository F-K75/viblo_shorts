# Phase 2.5 Track D-1: security and data hardening (F8, F9, F10, F11, D6, D2, D7)

**Status: second review pass complete (§13); PR on HOLD pending the owner's review. Not merged.** D-2 has not been started; per the owner's instruction it waits for D-1 to be
reviewed and merged. Passing CI is not merge approval and not production-release approval.

* **Base:** `main` @ `6ee9c11` (Track A merge) plus the docs-only re-audit commit `14c1438` (incorporated as the first
  commit of this PR, as instructed).
* **Branch:** `claude/keen-feynman-xtbvz2-track-d1`. **PR:** F-K75/viblo_shorts#7.
* **Order followed:** F8 → F9 → F10 → F11 → D6 → D2 → D7, then one gate finding (§8).
* **Out of scope and not done:** D-2 items (D1, D3, D5, D8, D9, D10), Track E, AWS provisioning, deployment, production
  data and production migrations, paid services, unrelated refactoring.

Every fix was preceded by a regression test that failed on the previous implementation (`main` @ `6ee9c11`, or `3aa217c`
for the gate finding). Tests marked *verification* were written after the fix and say so in their commit message.

## Commits (one item per commit pair)
| Item | Red test (failed before the fix) | Fix / verification |
|---|---|---|
| re-audit (docs) | — | `14c1438` |
| F8 | `c30984f` | `98273f9` |
| F9 | `278a39f` | `98bd3f3`; verification `8d24fba` |
| F10 | `e4a05ff` | `6bd68b1`; verification `400e6c7` |
| F11 | `148561c` | `f1f485a` |
| D6 | `8136041` | `1b07ab7` |
| D2 + D7 | verification checks of existing behaviour (CI docker job) | `3aa217c`; D2 fixture corrections `8dd680a`, `a5a4093` (§6) |
| Gate finding (§8) | test and fix in one commit; red evidence below | `a7b083e`; test correction `419351d` |
| Evidence docs | — | `106212a` (draft), this commit (final) |

---

## 1. F8: project ownership enforced inside the save; deleted projects are never resurrected
**Problem.** Two users saving the same *new* project id at once could both succeed. The loser overwrote the winner's
document and charged its own quota counters. An update racing a delete re-created the deleted project.

**Exposure (correction, review of 2026-11-09).** Over HTTP, project ids are always issued by the server (`server.ts`,
"an unknown client id is treated as a new project with a fresh id"). So the new-id race was reachable only at the
repository layer. The defect a client could actually trigger was the resurrection. The fix and tests are unchanged.

**Root cause.** `saveProject` locked the existing row with `FOR UPDATE`, but an id that does not exist yet has no row to
lock. Both transactions saw "new". The second `INSERT … ON CONFLICT (id) DO UPDATE` then had no owner predicate. The
update route also had no way to say "this must still exist".

**Red evidence (6ee9c11).**
* Both backends: an update that requires the project to exist re-created it after a concurrent delete ("Missing expected
  rejection").
* PostgreSQL: two users saving one new id concurrently, round 1: `fulfilled, fulfilled`.

**Implementation.**
* PostgreSQL takes a per-project-id advisory transaction lock, `pg_advisory_xact_lock(7311, hashtext(id))`, after the
  users-row lock. Every save of one id is serialized, so the existence and owner check is exact. It is one advisory lock
  per transaction, always taken after the users row, so the lock order cannot deadlock.
* The upsert only updates `WHERE projects.user_id = EXCLUDED.user_id`. Zero rows written raises `ProjectOwnershipError`
  and rolls back every counter change.
* `saveProject(…, { mustExist: true })` raises `ProjectNotFoundError` on both backends. The route maps it to the same
  404 as an ownership error, so existence is not disclosed.

**Concurrency.** 10 rounds of two users racing one new id (PostgreSQL). Exactly one save wins per round. Per-user
counters and `storage_totals` equal a recount from the rows after every round (no drift).

**Residual risk.** `hashtext` collisions between two ids only serialize unrelated saves briefly; correctness is not
affected.

## 2. F9: the data-migration counter rebuild is correct under live writes and bounded per statement
**Problem.** The JSON → PostgreSQL migration rebuilds quota counters at the end. A live save committing during the
rebuild could be overwritten (counter drift). On large data the rebuild exceeded the statement timeout.

**Root cause.** The rebuild was one `UPDATE users … FROM (SELECT sum …)` at READ COMMITTED. Its sums came from the
snapshot taken when the statement started. When it then waited for a live save's users-row lock, it wrote the stale sum
over that save's increment (lost update). As one statement over every user it was also unbounded.

**Red evidence (6ee9c11).**
* A live write holds a users-row lock. The rebuild is observed waiting on it (`pg_stat_activity.wait_event_type =
  'Lock'`). The live write commits. Result: counter drift.
* 100 000 users and 200 000 projects under `DATABASE_STATEMENT_TIMEOUT_MS=400`: "canceling statement due to statement
  timeout".

**Implementation (`rebuildCounters`, `server/db/dataMigration.ts`).**
1. Lock the `users` rows in keyset pages of 1 000 (`FOR UPDATE`). This is the same order live writes use (users, then
   `storage_totals`).
2. Lock `storage_totals` (`FOR UPDATE`).
3. Lock `users` again, to catch users created and committed in between, and collect the ids.
4. For each page, run a fresh statement: a CTE computes the sums and `UPDATE … RETURNING kind, bytes`. The totals are
   the sum of the pages, computed with BigInt.

Every statement is small, and the statement timeout was not raised. The migration is still one transaction.

**Locking and operational impact.**
* While the migration transaction runs, it holds row locks on every `users` row and on `storage_totals`. Live project
  saves and deletes **wait** until it commits.
* A save that waits longer than the request statement timeout (default 10 s) fails, and its transaction is rolled back,
  so nothing is half-applied. The statement-timeout error (`57014`) is not classified as "database unavailable", so the
  client gets a generic server error, not the 503 retry hint. Plain reads are not blocked.
* This is a one-off cut-over step. Runbook §6 (`docs/BACKUP_AND_RECOVERY.md`) already requires a write freeze with the
  JSON server stopped, so in the documented procedure no live writes are waiting. The F9 fix makes the rebuild correct
  even if writes do arrive.
* No production migration has been run or authorized.

**Failure injection and recovery (verification).** A fault-injection trigger fails the rebuild on user `f9i_2500`, in
the middle of the pages. The whole migration rolls back: no partial counters and no partial rows. A re-run then produces
exact counters.

## 3. F10: AI reservation lifecycle: refund only if the model call provably never started
> **Superseded in part by the review pass (§13, R1 and R2, owner decisions of 2026-11-09).** The charge now follows the
> recorded provider usage of every attempt, not the start alone, and the start is written to disk synchronously on the
> JSON backend. This section describes the D-1 implementation as first reviewed.

**Owner decision (2026-11-03):** "Refund if the model call has provably not started. Charge if it has started or its
state is uncertain."

**Problem.**
* A client abort was always settled as a charge, even when the model never ran.
* Crash expiry refunded every stale reservation, even ones whose model call may have run (free generations after a
  crash).
* The expiry comment claimed row locks that the autocommit statement does not hold.

**Root cause.** Reservations had no "model call started" state, so these cases could not be told apart.

**Red evidence (6ee9c11), both backends.**
* `startAi` is not a function: no started state exists.
* The server settles every abort as a commit.
* Expiry refunds every open reservation.

**Implementation.**
* Migration `0005_ai_reservation_started.sql`: `ai_reservations.started_at timestamptz`. It is expand-only and marked
  `-- forge:backward-compatible`. The JSON ledger persists the same `started` flag.
* States are reserved → started → committed | refunded. Every transition is conditional on the reservation being open
  (`status = 'reserved'`), so each reservation has exactly one final outcome: no double refund and no double charge.
* `beginModelCall()` runs immediately before the first model invocation (text routes and TTS). It does not call the
  model if the client socket is already gone or the reservation is already settled.
* Settlement outcomes:
  * real output → `commit`;
  * a complete response without a charged result → `refund` (unchanged);
  * client disconnect → `abort`. The decision is made on the row in the same statement: refunded if `started_at IS
    NULL`, committed otherwise.
* Expiry settles stale reservations as `abort` (never started → refunded, started → committed). The comment is
  corrected and the log event renamed `ai_reservations_expired`.

**Tests.**
* Lifecycle on both backends.
* Crash recovery on JSON (close, reopen, expire returns 2, and only the started reservation stays charged).
* PostgreSQL: 40 rounds of `startAi` racing aborts and commits, with exactly one final state per reservation.
* Verification through the real HTTP path, using the Gemini stub:
  * completed call → charged;
  * client disconnect after the stub received the call → charged;
  * provider failure with a complete fallback response → refunded.

**Residual risk.** "Started" is recorded immediately before the outbound call. A crash between the write of `started_at`
and the request leaving the process charges a call that never reached the provider. This is the uncertain case the owner
decided to charge.

## 4. F11: backups verify `ai_reservations` (count and content); every backup connection follows the TLS policy
**Problem.**
* `ai_reservations` was dumped but never verified, and verification compared row counts only.
* The backup tool's own connections ignored the application's TLS policy.
* `pg_dump`, `pg_restore` and `psql` used libpq's default `prefer`, which silently allows plaintext.
* The backup image did not run with `NODE_ENV=production`.

**Red evidence (6ee9c11).**
* The manifest has no `ai_reservations` count.
* Rows changed with equal counts pass verification.
* `libpqEnv` leaves `PGSSLMODE` unset under the production policy.
* `rowCounts` and `createBackup` connect in plaintext under `DATABASE_SSLMODE=require` ("Missing expected rejection").

**Implementation.**
* `BACKUP_TABLES` adds `ai_reservations` and `captcha_redemptions`.
* The manifest records a per-table, order-independent content checksum. It is read in the dump's snapshot with fixed
  session text formats (UTC, DateStyle, IntervalStyle, `extra_float_digits`, `bytea_output`).
* Restore and verify-restore compare counts **and** checksums. Equal counts with different content are reported as
  `contentChanged`. Manifests written before F11 (no checksums) still verify by counts.
* `connect()` uses `tlsConfig`. `libpqEnv` derives `PGSSLMODE` from the same policy: `disable`, `require`, or
  `verify-full`/`verify-ca` with `PGSSLROOTCERT=system` when no root certificate is given. It is never `prefer`.
* `Dockerfile.backup` sets `NODE_ENV=production`.

**Tests.**
* The manifest has the `ai_reservations` count (5), a `captcha_redemptions` entry and checksums.
* A restore verifies. A deleted row is reported as `{table:'ai_reservations', expected:5, actual:4}`, and a changed row
  as `contentChanged: true`.
* Every `libpqEnv` policy case is covered.
* Under `DATABASE_SSLMODE=require` and under `NODE_ENV=production`, `rowCounts` and `createBackup` against a server
  without TLS are rejected with an SSL/TLS error.

**Residual risk.** `PGSSLROOTCERT=system` needs libpq 16 or later; the backup image installs `postgresql-client-17`. Hosts running the backup CLI outside that image need libpq 16+ for the verified-TLS default.

## 5. D6: guest tokens have exactly one accepted encoding
**Owner decision:** "Reject non-canonical encodings."

**Root cause.** Node's lenient base64url decoder ignores the unused bits of the last character. It also accepts `=`
padding, the standard alphabet and stray characters. Different strings that decode to the same signature bytes all
verified (malleable tokens).

**Red evidence (6ee9c11).** A signature that differs only in its unused bits verifies in `AuthService`, and the server
answers 200 instead of the normal invalid-token 401.

**Implementation.** Before any cryptographic work, each part must use the URL-safe alphabet without padding and must
equal the re-encoding of its own bytes. Otherwise the token gets the normal 401 with no detail. The HMAC and its
constant-time comparison are unchanged. Tokens minted by the current implementation are canonical and keep working.

**Tests.** The variants covered are unused bits, `=` padding, the standard alphabet and an embedded newline. The server
returns exactly the same status and body as for a garbage token. The original tamper test is unchanged; it was neither
removed nor weakened.

## 6. D2: restore guard in the real container (verification)
`scripts/ci/docker-restore-guard.sh` runs in the CI `docker` job. The steps:
1. Real data goes into a volume.
2. A snapshot is taken with the image's own backup CLI, and a newer project is written after it.
3. A **real** restore runs inside the container and is SIGKILLed on its second `.pre-restore-` rename
   (`scripts/ci/kill-restore-midswap.mts`, exit 137). This leaves a genuine unfinished-restore journal.

Expected results:
* The app container exits 1 with "Refusing to start: an interrupted restore".
* The volume stays byte-identical (sha256 of every file, before and after the refused start).
* `backup recover` reports `"state": "rolled-back"`.
* The app then starts and serves both the snapshot project and the newer one.

**First CI runs failed, and the cause was in the test fixture, not the product.**
* Runs 39, 41, 42 and 43 failed with "restore finished without being killed (the fixture did not trigger)", exit 3.
* My first explanation (only one store entry, so the second aside rename never happened) was **wrong**. The same
  fixture fired locally against a data directory with two entries.
* `8dd680a` made the fixture log every rename. Run 43 then showed the hook matching
  `/data/projects -> /data/projects.pre-restore-…` and issuing the SIGKILL, yet the process carried on.
* **Root cause:** with `--entrypoint node`, Node was the container's PID 1. The kernel ignores signals that a
  PID-namespace init process sends itself without a handler, SIGKILL included. Locally Node is never PID 1.
* `a5a4093` runs the fixture under the image's tini, as the app runs. Run 44 then passed every assertion (§10).
* `8dd680a` also kills right after the *first* aside rename, so the check works for any number of store entries. It
  makes the D7 step run even if D2 fails, so one check cannot hide the other's evidence.

## 7. D7: stopping Node also stops its ffmpeg renders (verification)
`scripts/ci/docker-ffmpeg-termination.sh` uses the production image: tini is PID 1 and Node is its child. It starts a
real 1080p, 60 s render and reads the host PIDs of tini, Node and ffmpeg through `docker top`.

**Signal path.**
* Normal case, `docker stop`: SIGTERM goes to tini, which forwards it to Node. Node's shutdown kills its ffmpeg children.
* Forced case: SIGKILL to the Node process only, from the host. tini reaps it and exits, which ends the container's PID
  namespace; the kernel kills every remaining process in it, including ffmpeg.

Both cases must leave **no** tini, Node or ffmpeg host PID alive. This is checked with `ps -p`, which works across uids
(`kill -0` gives false negatives for another user's process). It is not assumed from the presence of tini.
`NODE_ENV=test` is used only so that a throwaway Firebase test key is accepted: renders need a signed-in user.

**Local limitation (D2 and D7).** The image cannot be built in this environment, because the proxy blocks the Debian
mirror (CONNECT 403). Both checks ran only in CI (§10). The D2 flow was also run locally without Docker (same scripts,
same environment, a scratch copy of the fixture): exit 137, journal present, refusal with exit 1, `rolled-back`, both
projects served. D7 has no local equivalent.

## 8. Gate finding: guest-mint refusal stats were recorded after the answer (merged Track A code)
**Found by** the D-1 full PostgreSQL gate on `3aa217c`. The failing test was Track A `A-decisions` "shared-network
refusals … recorded apart" (`tests/guest_protection.test.ts:432`), with `undefined !== 1`. The run did not cross an
hour boundary (14:46–14:49 UTC). The same test passed in CI run 39 on `3aa217c`: it is intermittent.

**Root cause.** Every refusal stat was written fire-and-forget: `repo.recordStat(…).catch(() => {})` without `await`,
before the 429 or 403 response. This covered `guest_rate_limited:<scope>`, the shared-network series and every
`refuseGuestMint` code. A diagnostics read issued after the client had its answer could run on another pooled connection
before that write committed.

**Red evidence (3aa217c).** A new regression test (PostgreSQL) installs a trigger that delays only the refusal-stat
writes by 1.5 s. The diagnostics read straight after the 429 then fails with the same signature as the gate failure:
"the IP refusal is recorded before the 429 is sent: undefined !== 1".

**Implementation (`a7b083e`).** The best-effort writes are awaited before the response; errors are still swallowed.
Counting is unchanged: each refusal is still recorded exactly once. This is a timing fix to merged Track A code, kept in
its own commit; the owner may ask for it to be moved.

**Results.** The new test passed 3 runs out of 3. The Track A file passes 23/23 on JSON and 23/23 on PostgreSQL.

**Residual risk.** A refusal now waits for its stat write. If the database is slow, the refused client gets its answer
later; it is still refused, and limit enforcement does not depend on the stat.

---

## 9. Local gate (final head)
Run on `419351d`. The later commits (`8dd680a`, `106212a`, `a5a4093` and this one) change only `scripts/ci/`,
`.github/workflows/ci.yml` and `docs/` (`git diff --stat 419351d a5a4093`), so no application or test code changed after
the gate. Local PostgreSQL 16; logs are in the session scratchpad.

| Check | JSON | PostgreSQL |
|---|---|---|
| `tests/track_d1.test.ts`, run 1 | 18/18 | 18/18 |
| `tests/track_d1.test.ts`, run 2 | 18/18 | 18/18 |
| `tests/track_d1.test.ts`, run 3 | 18/18 | 18/18 |
| Full suite (272 tests) | 270 pass, **0 fail**, 0 cancelled, 2 skipped | 263 pass, **0 fail**, 0 cancelled, 9 skipped |
| Build (`tsc` ×2, `vite build`) | passes | passes |
| Browser E2E | 2/2 | 2/2 |

**Earlier gate on `3aa217c`, failures reported, not retried silently:**
* JSON full suite, 1 failure: Track C "60 slow 450 KB uploads + 20 oversized…", 2 of 20 oversized uploads got
  `write EPIPE` instead of 413. This is the known intermittent test-helper issue, D8, scheduled for D-2. It did not
  recur on `419351d`. That does **not** mean it is fixed.
* PostgreSQL full suite, 1 failure: Track A `A-decisions`. Root-caused and fixed (§8).

## 10. CI
**Run 44 on `a5a4093`: green. Every job's log was read.**

| Job / step | Result (from the log) |
|---|---|
| `test`: checkout, install, typecheck | step conclusions `success`. The fetched log is capped at 5 000 lines and starts during the JSON suite, so these steps are evidenced by status only. |
| `test`: JSON suite | 272 tests, 270 pass, **0 fail**, 0 cancelled, 2 skipped |
| `test`: every server on PostgreSQL | 272 tests, 263 pass, **0 fail**, 0 cancelled, 9 skipped |
| `test`: D-1 tests (F8, F9, F10, F11, D6, gate finding) | 11 suites `ok` in each suite run |
| `test`: build; E2E | build passes; E2E JSON 2/2, PostgreSQL 2/2 |
| `test`: `bun audit --audit-level=high` | "No vulnerabilities found (checked 389 packages, 2 below --audit-level=high, 1 ignored)" |
| `test`: E2E step's throwaway Playwright install | npm still prints "5 vulnerabilities (1 moderate, 4 high)". Track A risk 13; D-2 (D9). |
| `docker` (complete log, 2 305 lines, 0 `##[error]`) | migrations `0001`–`0005` applied (`"version":5`); two-instance PostgreSQL and JSON smoke tests pass; production refuses without TRUST_PROXY, without DATABASE_URL and without TURNSTILE_SECRET (exit 1 each) |
| `docker`: D2 | restore exit 137; `.restore-in-progress.json` and `projects.pre-restore-…` present; app exit 1 with "Refusing to start: an interrupted restore … phase swapping"; "volume unchanged by the refused start (11 files, sha256 identical)"; recover `"state": "rolled-back"`; "D2 PASSED" |
| `docker`: D7 | normal: tini, Node and ffmpeg host PIDs read, container exit 0, "ff-normal PASSED … no orphan"; forced (SIGKILL to Node only): container exit 137, "ff-forced PASSED … no orphan"; "D7 PASSED" |
| `docker`: backup image | `pg_dump`/`pg_restore`/`psql` 17.11, age 1.1.1, Node v22.23.4 |
| `live-llm` | skipped on pull requests: **0 live tests**. Not live validation. |

**Earlier failed runs on this PR (all root-caused):**

| Run | Head | Failure | Cause / fix |
|---|---|---|---|
| 39 | `3aa217c` | docker: D2 fixture did not fire | Node as PID 1 (§6); fixed in `a5a4093` |
| 40 | `a7b083e` | test: gate-finding test in the JSON suite (`client password must be a string`) | test needed its own database; `419351d` |
| 41, 42, 43 | `419351d`, `8dd680a`, `106212a` | docker: D2 fixture did not fire | same as run 39; run 43 is where the rename log confirmed the cause and D7 first passed |

`test` in run 39 (`3aa217c`) was green, including the Track A test that failed locally. It is intermittent, which is why
it needed a deterministic reproduction (§8).

## 11. Skipped tests (with reasons)
The same skips appear locally and in CI run 44. No D-1 test is skipped.

| Skipped test(s) | Backend | Reason |
|---|---|---|
| 2 live Gemini tests (`LIVE: generate-script…`, `LIVE: generate-clips…`) | both | `GEMINI_API_KEY` not set; reported as "NOT passed". Track E. |
| 7 JSON-specific tests (corrupt shards, volume snapshot restore, legacy store migration, scheduled snapshot, async route failures on a corrupt store) | PostgreSQL | JSON-backend specific; PostgreSQL equivalents are in `tests/phase2.test.ts` |
| `live-llm` CI job | — | does not run on pull requests |

## 12. Accepted risks (owner decisions) vs. unresolved defects
**Accepted risks (owner decisions):**
* F10: an uncertain model-call state is charged (§3 residual).
* Track A deviations (cookie only, weaker escalation, no emergency budget, fixed-window burst) are unchanged by D-1.

**Residual risks introduced or documented by D-1** (not defects; need the owner's acknowledgement):
* F9: live saves and deletes wait while the data migration commits (§2).
* F11: `PGSSLROOTCERT=system` needs libpq 16 or later.
* The gate finding: a refusal waits for its stat write (§8).

**Unresolved defects:**
None introduced by D-1. Still open and tracked for D-2 (not in D-1's scope):
* D8: intermittent `write EPIPE` in the Track C upload test (seen on `3aa217c`, not on `419351d`).
* D9: the Playwright throwaway install reports 5 vulnerabilities (1 moderate, 4 high).
* The CI database connection headroom from Track A is unchanged, and not re-measured in D-1.

---

## 13. Second review pass (owner decisions and requests of 2026-11-09)
PR #7 was on HOLD after the first review of `614c56b`. The owner decided:
* accept the Track A fix;
* add the F9 runbook steps;
* make the F10 JSON start durable and settle F10 by actual provider usage;
* add the F11 TLS restore tests;
* keep the D2/D7 checksum evidence.

The owner then asked for:
* the F10 outcome matrix and concurrency evidence;
* migration `0006` upgrade and recovery evidence;
* sustained load results for Track A.

Merge, D-2 and deployment are **not** authorized.

### 13.1 Commits since `614c56b`
| Commit | Kind | Item |
|---|---|---|
| `9975e26` | red test | R1: a crash within the 1 s flush loses the model-call start (`0 !== 1`) |
| `4a93567` | fix | R1: the JSON ledger persists the start synchronously before the provider is called |
| `f4d2685` | red tests | R2: billing must follow provider usage (both backends) |
| `4e87cc0` | fix | R2: per-attempt records, settlement by usage, migration `0006` |
| `4fc90a4` | tests (mutation-checked) | R4: F11 TLS-required restore and verify-restore, TLS downgrade |
| `20e870c` | docs | R3: F9 runbook, write freeze for every `migrate` run |
| `c776e33` | measurement script | R5: concurrent load, Track A refusals |
| `fa88a9e` | docs | F8 exposure correction; F10 §3 marked superseded in part |
| `b9a610c` | test helper | Gemini stub arrival hook (R1 evidence) |
| `2c7b74a`, `fa9b618` | measurement script | R5: pool and throughput sampling, below the probe rate limit |
| `6db5dbd` | test | F1 write-storm precondition (CI finding, §13.8) |
| `378d028` | tests (mutation-checked) | R1, R2 and R6 evidence |
| this commit | docs | this section and the re-audit |

Application code changed only in `4a93567` and `4e87cc0`:
* `server.ts`;
* `server/lib/{usage,jsonRepo,repo}.ts`;
* `server/db/pgRepo.ts`;
* `server/db/migrations/0006_ai_reservation_attempts.sql`.

Everything else is tests, test helpers, a measurement script and docs.

### 13.2 R1: F10 durability before the provider call (JSON)
**Red (`9975e26`, on `614c56b`).** With the production 1 s debounce, a crash right after the start left the reservation
on disk without `started`. Recovery refunded it (`0 !== 1`).

**Fix (`4a93567`, superseded by R2's `beginAttempt`, which keeps it).** The attempt record is written synchronously
(atomic rename) before the method returns. If the write fails, the attempt is undone and refused, so the provider is not
called.

**Evidence (`378d028`):**
* **No provider call before persistence.** The stub inspects durable state at the instant each request arrives: the
  file on disk for JSON, a committed row seen from another connection for PostgreSQL. Two attempts (500, then success)
  showed `[{open:1,total:1},{open:1,total:2}]` on both suite backends.
* **Failed disk write.** `usage.json` was replaced by a directory, so the atomic rename fails, also as root. The
  provider received **0** calls, the user got the template fallback, the quota was unchanged (refunded), and the server
  logged `usage_attempt_not_persisted`.
* **Crash recovery.** No flush and no close after the start, then a new process: the reservation is charged (R1 test),
  and an in-flight attempt at the crash is charged (R2 repository tests).
* **Mutations caught:** a debounced attempt write (2 tests fail); the provider called before the attempt is recorded
  (1 test fails).

### 13.3 R2: F10 billing by actual provider usage
#### F10 billing outcome matrix (as implemented)
**Terms used below:**
* **Invocation:** the server sends a provider request. Every invocation is preceded by a durable `beginAiAttempt`.
* **Execution:** the provider processed the request. The server cannot observe this directly; it infers it from the
  response.
* **Billable usage:** the provider reported usage greater than 0 (`usageMetadata.totalTokenCount`, or prompt plus
  candidate tokens).

**One reservation is one daily-quota unit:**
* It is settled exactly once, by a conditional `status = 'reserved'` transition.
* The charge is 0 or 1 unit, never more, however many attempts were made.
* Tokens are recorded for audit; they are not priced.

**Settlement rule `usage`:**
* **Charge** if any attempt is `billable`, any attempt is `uncertain`, or an attempt is still open.
* **Charge** a legacy row (`started_at` set, no attempt records).
* **Refund** otherwise.

**Per-attempt outcomes:**

| # | What happened on an attempt | Invocation | Execution known? | Classified as | Effect on the reservation |
|---|---|---|---|---|---|
| 1 | Not attempted: no API key, validation error before the call, template only | no | n/a | (no attempt) | refund, unless another attempt decides otherwise |
| 2 | Client already gone, or reservation already settled, when an attempt would begin | **no** (refused before the call) | n/a | (no attempt) | as 1 |
| 3 | The durable attempt record cannot be written (JSON disk error, PostgreSQL error) | **no** | n/a | (no attempt) | as 1 |
| 4 | HTTP 200, usage > 0, output valid | yes | yes | billable | **charge** |
| 5 | HTTP 200, usage > 0, output unusable (unparseable or empty; the user gets the template) | yes | yes | billable | **charge** |
| 6 | HTTP 200, usage reported as 0 | yes | yes | not billable | refund (unless another attempt charges) |
| 7 | HTTP 200 without usage metadata | yes | yes, usage unknown | uncertain | **charge** |
| 8 | HTTP 4xx/5xx error response (`ApiError` with a numeric status): 400, 401/403 (credentials), 429, 500, 503 | yes | provider answered with an error; whether it bills is **not verified** | uncertain (**owner decision 2026-11-09**, `d19a521`) | **charge** (conservative) |
| 9 | Timeout (our `AbortSignal.timeout`), network reset or other error without an HTTP status | yes | **unknown** | uncertain | **charge** |
| 10 | Client disconnects while an attempt is in flight | yes | resolved by the attempt's own outcome | 4 to 9 | settlement **waits** for the attempt's outcome; no new attempt starts after the disconnect |
| 11 | The process crashes while an attempt is in flight | yes | unknown | attempt left open | recovery (expiry) **charges**, never an automatic refund |
| 12 | The process crashes after attempts ended, before settlement | as recorded | as recorded | as recorded | recovery settles by the recorded outcomes |
| 13 | Recording an attempt's outcome fails | yes | unknown to the ledger | attempt left open | **charge** (never an unrecorded refund) |

**Retries and failover:** each retry or failover model is its own attempt (rows 4 to 9), and the rule applies across all
of them:
* 500 then success: charged once.
* 500 then 500: charged once (both attempts uncertain).
* Timeout then success: charged once.
* Timeout then 500: charged (the timeout was uncertain).

**Parallel calls:**
* No route issues parallel provider calls for one reservation. Each request makes one provider call chain, attempts in
  sequence.
* The ledger still supports parallel attempts on one reservation:
  * the in-process `openAttempts` counter, and `attempts_open` in the database, are atomic counters;
  * settlement is a single conditional statement that reads them.
* Tested: 8 parallel attempts racing 3 settlements, 20 rounds, both backends. Result: exactly one settlement, a charge of
  0 or 1, and always charged when any attempt was billable or uncertain.

**Row 8, owner decision (2026-11-09): conservative.**
* Google's billing for error responses could not be verified: this session's network blocks `ai.google.dev`.
* An unknown provider billing outcome must never become an automatic refund, so every provider error after invocation
  is `uncertain` and charged.
* This is our reservation-settlement policy. **It is not a claim that Gemini billed the request.**
* Implemented in `d19a521`, red first in `16e52fb`.
* **Accepted consequence:** during a provider outage, failed calls consume the user's daily AI quota. They still get
  the template fallback.

**Policy summary (owner's table):**

| Situation | Settlement |
|---|---|
| Local validation fails before provider invocation | refund (rows 1–2) |
| Durable attempt write fails | provider not invoked; refund (row 3) |
| Provider returns success | charge according to confirmed usage (rows 4–6; usage reported as 0 → refund) |
| Provider returns HTTP 4xx/5xx | charge, conservatively (row 8) |
| Network timeout after invocation | charge (row 9) |
| Provider response cannot be classified | charge (rows 7, 9, 13) |
| Multiple attempts, at least one uncertain or billable | one charge (one unit per reservation) |
| All attempts provably never started | refund |


**Evidence:**
* **Server-level (`f4d2685`, red then green).** One request each for:
  * unusable output with usage → charged;
  * 0 usage → refunded;
  * no usage metadata → charged;
  * 500 on every attempt → charged once (`d19a521`; refunded before the owner's decision);
  * HTTP 400 from the provider → charged (`d19a521`);
  * 500 then success → charged once, and on PostgreSQL `attempts_total=2, attempts_open=0, billable_attempts=1,
    uncertain_attempts=1, billable_tokens=30`;
  * timeouts → charged;
  * a disconnect during an attempt that then returns 500 → charged (`d19a521`), with no provider call after the
    disconnect.
* **Repository level (both backends).** Lifecycle, idempotency, crash in flight → charged, crash after a failed attempt
  → refunded.
* **PostgreSQL.** 40 rounds of begin racing settlement: an attempt that began is never refunded while open, and a
  refunded reservation never began.
* **Concurrency (`378d028`, both backends).** 20 rounds × 8 parallel attempts on **one** reservation, their outcomes
  racing 3 settlements:
  * exactly 1 settlement each time;
  * charge delta 0 or 1;
  * always 1 when an attempt was billable or uncertain;
  * the status matches the charge;
  * every attempt end is recorded, also after settlement.

  Mutations caught: open attempts ignored at settlement; settlement without the `status = 'reserved'` condition.
* **Phase 1 quota test** (`tests/phase1.test.ts`), changed with the owner's decision (`16e52fb`): an invalid request
  (no provider call) still costs nothing. Provider error responses now consume quota: 2 failed calls use a quota of 2,
  and the third request gets 429.
* **Earlier D-1 F10 tests** were migrated to the attempt API (`startAi` → `beginAiAttempt`, `'abort'` → `'usage'`). One
  assertion changed meaning: several attempts per reservation are now allowed and recorded.

### 13.4 Migration `0006` upgrade and recovery evidence (R6, `378d028`)
`0006` adds five `NOT NULL DEFAULT 0` columns to `ai_reservations` and is marked backward-compatible. On PostgreSQL 11+
this is a metadata-only change with no table rewrite.

On a real version-5 database (migrations `0001`–`0005` only), with rows in every state the previous release writes
(open, started, committed, refunded, plus their usage counts):

| Check | Result |
|---|---|
| Interruption 1: the table is busy (`ACCESS SHARE` held by another session); migration lock timeout | fails with "0006_ai_reservation_attempts.sql failed (lock timeout …)"; still version 5; no new column |
| Interruption 2: the migrating **process is SIGKILLed** while its `ALTER` waits for the lock; the lock is then released | the orphaned session ends without committing; still version 5; no new column |
| Recovery: normal re-run | applies `0006` exactly once (version 6); a second run applies nothing |
| Existing rows | byte-identical in all existing columns (md5 over the legacy rows); new columns 0 |
| The previous release against version 6 | its migrator (`migrate.ts`, unchanged since `6ee9c11`, with only `0001`–`0005`) applies nothing and reports `newerCompatible: ['0006_…']`; its settle statement (verbatim from `614c56b`) charges an in-flight attempt begun by this release |
| This release on legacy rows | recovery charges the legacy *started* row, refunds the never-started one, and leaves settled rows unchanged; the usage count follows (3) |
| JSON: a `usage.json` written by the previous release | loads; a started reservation is charged by recovery, a never-started one refunded |

Mutations caught: the legacy clause removed (PostgreSQL), and legacy JSON rows treated as never started.

**Deploy order:**
* **Rolling upgrade:** apply `0006`, which the new release does at startup under its advisory lock. Old instances keep
  running against version 6.
* **Rollback:** the previous image runs against version 6 unchanged. Rows begun by the new release keep `started_at`,
  so the old rule charges them, which is conservative.

### 13.5 R3: F9 runbook
`docs/BACKUP_AND_RECOVERY.md` §6 (`20e870c`) has these steps:
* 0: rehearse.
* 1: enter the freeze by stopping every instance (there is no maintenance mode).
* 2: verify that writers have stopped: no `forge-studio:<instance>` session in `pg_stat_activity`, and the JSON lock
  refuses `migrate` (never `--force`).
* 3: confirm that no write is outstanding: no active statement or open transaction.
* 4: migrate or re-run.
* 5: verify integrity: report fields, plus recount queries for the user counters and `storage_totals`.
* 6: resume writers.
* 7: verify normal operation.

A write freeze is required for **every** run, including re-runs while PostgreSQL is live.

**Rollback** keeps the tested export procedure.

**Interruption:** `migrate` is one transaction. A failure or a killed process commits nothing (§13.4 shows this for
schema migrations; the data migration's own rollback is in §2). Re-run after fixing the cause; it is idempotent.

**SQL verification on a real database:**

| Query | Healthy | After corruption | Live session |
|---|---|---|---|
| Recount, user counters | 0 | 1 (a user counter corrupted) | |
| Recount, `storage_totals` | 0 | 1 (the guest total corrupted) | |
| Writer check (step 2) | | | lists a connected `forge-studio:inst-1` session |
| Outstanding writes (step 3) | | | lists its open transaction, and nothing once it ended |

### 13.6 R4: F11 TLS-required restore and verify-restore (`4fc90a4`)
* **TLS proxy.** A TLS-terminating proxy in front of the local PostgreSQL (which has TLS off) records, per connection,
  whether TLS was negotiated and the `application_name`.
* **Positive.** Restore and verify-restore with TLS required both succeed. **Every** connection negotiated TLS: the Node
  `forge-backup-verify` connections and the libpq `psql` stage. None was plaintext.
* **Refusal.** With `DATABASE_SSLMODE=require`, and with the production default, restore and verify-restore against a
  server without TLS are refused (`SSL`/`TLS` error). The target has no tables afterwards.
* **Downgrade.** TLS is stripped only on the third connection (`psql`), while a plaintext client would be accepted.
  The restore aborts, `psql` does not fall back, and nothing is written.
* **Mutations:**
  * libpq `prefer` → caught by the downgrade test;
  * libpq `disable` → caught by 2 tests;
  * the Node client without the TLS policy → caught by all 3.

### 13.7 R5: Track A under sustained refusal floods (`scripts/load/guest-refusal-concurrency.mts`)
**Setup:**
* 25 concurrent clients for 60 s per phase: 15 refusal clients (no CAPTCHA token), 5 doing a mint then an IP-limited
  refusal, and 5 legitimate signups.
* Pool size: the **production default of 10, not changed**.
* Pool samples come from `/api/health/details`: the waiting count, and `latencyMs` of a `SELECT 1` through the
  application pool, which measures connection acquisition.
* Slow phase: an INSERT-only trigger adds 300 ms to each refusal-stat write. It runs without holding the counter row's
  lock, so it models a slow database rather than lock serialization.

| 60 s phase | Pre-fix `3aa217c` | Current `378d028` |
|---|---|---|
| Healthy: legitimate signups/s | 88.1 | **137.9** |
| Healthy: signup p50 / p95 / p99 | 54 / 84 / 98 ms | **35 / 54 / 66 ms** |
| Healthy: refusals/s (no token); p50 | 1 028; 13.6 ms | 925; 15.4 ms |
| Healthy: pool waiting p50 / max; acquire p50 / p95 | 21 / 29; 8 / 14 ms | 12 / 17; 5 / 8 ms |
| Slow writes: legitimate signups/s | 2.2 | **7.0** |
| Slow writes: signup p50 / p95 / p99 | 2 433 / 2 711 / 2 717 ms | **669 / 925 / 982 ms** |
| Slow writes: refusals/s (no token); p50 | 31.3; 585 ms | 26.8; 578 ms |
| Slow writes: pool waiting p50 / max; acquire p50 / p95 | 38 / 48; 464 / 817 ms | 15 / 20; 151 / 436 ms |
| 5xx or network errors | 0 | 0 |
| Refusal stats recorded vs. refusals sent | equal | equal |

**Residual risk (not removed by the fix):**
* Refusals and legitimate signups share one pool of 10. Under a refusal flood while the database is slow, the pool is
  saturated (10 connections, 15–20 waiting) and legitimate signups take 0.7–1 s at p50–p99.
* That is 3.6× faster than before the fix, at 3× the throughput, with no errors, but it is not isolated.
* **Options, not implemented, for the owner to decide:**
  * a separate small pool or a bounded queue for stat writes;
  * sampling or aggregating refusal stats in memory.

### 13.8 CI finding: F1 write-storm precondition (`6db5dbd`)
**What failed.** CI run `42614874907` on `fa88a9e` (`test` job, JSON-suite step: 281 tests, 278 pass, 1 fail) failed
only the **precondition** of the F1 test: "the writer really ran during the backup (2 writes)", where more than 20 were
expected. The backup and restore assertions never failed.

**Locally:**
* 9 instrumented runs: 177–268 writes before the backup and 55–135 during it.
* 5 runs alongside the D-1 suite: all pass.

**Cause.** The CI writer was about 100× slower, likely from disk contention with the parallel test files. That is not
confirmed from the log.

**Fix.** The old precondition could also pass with no write overlapping the backup. It now waits for 20 committed
writes (up to 15 s), then requires at least 1 write committed **during** `createBackup`. The restore assertions are
unchanged. The file passed 3 of 3 runs.

### 13.9 Local gate
| Check | Result |
|---|---|
| `tests/track_d1.test.ts` (27 tests) ×3 on `c776e33` | JSON 27/27, 27/27, 27/27; PostgreSQL 27/27, 27/27, 27/27 |
| `tests/track_d1_review.test.ts` (6 tests) ×3 on `378d028` | JSON 6/6 ×3; PostgreSQL 6/6 ×3 |
| Full JSON suite, `c776e33` | 281 tests, 279 pass, **0 fail**, 0 cancelled, 2 skipped |
| Full PostgreSQL suite, `c776e33` | 281 tests, 272 pass, **0 fail**, 0 cancelled, 9 skipped |
| Build, `c776e33` | passes |
| Browser E2E, `c776e33` | JSON 2/2; PostgreSQL 2/2 |
| Full suites on the final head (`fa9b618`) | _pending (running)_ |

Skips are unchanged from §11: 2 live Gemini tests (no `GEMINI_API_KEY`, **not passed**), and 7 JSON-only tests on
PostgreSQL.

### 13.10 CI on the final head
_Pending: CI run 51 on `fa9b618` (code head) and the run on the final docs head; every job log will be read._

### 13.11 Risks after the second pass
* **Accepted (owner):**
  * an uncertain attempt is charged;
  * a crash with an attempt in flight is charged.
* **Needs the owner's decision:**
  1. F10 row 8: whether HTTP 4xx/5xx is not billable (unverified against Google's documentation).
  2. Track A: the shared pool under refusal floods (§13.7).
* **Residual:**
  * F9: live writes wait during `migrate`; the runbook freeze prevents this.
  * F11: `PGSSLROOTCERT=system` needs libpq 16 or later.
  * Test proxy: TLS in the positive test runs with `rejectUnauthorized=false` (self-signed certificate). Certificate
    verification itself is covered by the `libpqEnv` policy unit test, not end to end.
* **Unresolved, D-2 scope:**
  * D8: EPIPE flake;
  * D9: Playwright throwaway-install vulnerabilities;
  * CI database and disk headroom (the F1 finding is one symptom).
* **Release blocker:** R-01 live Gemini validation (Track E).
