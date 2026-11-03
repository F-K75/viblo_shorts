# Phase 2.5 Track D-1: security and data hardening (F8, F9, F10, F11, D6, D2, D7)

**Status: ready for review. Not merged.** D-2 has not been started; per the owner's instruction it waits for D-1 to be
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
