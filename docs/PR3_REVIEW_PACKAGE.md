# PR #3 Review Package — Phase 2 (durable architecture) + corrective round

> **Update (2026-11-02):** the line-by-line code review (`docs/PR3_CODE_REVIEW.md`) found F1–F11. With your
> authorization, F1, F2, F3, F5 and F6 are fixed in this PR (§11). Each fix has a regression test that was run red
> against the unfixed code and green afterwards. F4 and F7–F11 are tracked, not fixed here (§9).

**PR:** [F-K75/viblo_shorts#3](https://github.com/F-K75/viblo_shorts/pull/3) · **Base:** Phase 1 branch
`claude/keen-feynman-xtbvz2` @ `194f5c5` (PR #2, not yet merged) · **CI:** see §7 for the run on the final head ·
**Status:** awaiting your review and explicit merge authorization.
**Not merged, not deployed. No infrastructure created.**

**Merge prerequisite:** PR #2 (Phase 1) merges first. Then this PR is retargeted to `main`; its diff stays the same
because it is stacked on #2.

---

## 1. Commit summary (29 commits, in order)
| # | Commit | Kind | What it does |
|---|---|---|---|
| 1 | `25e5b90` | feat(db) | Schema `0001_initial.sql`, migration runner, connection pool, `Repo` interface, `JsonRepo` (Phase 1 behaviour) and `PostgresRepo`; contract tests run on both |
| 2 | `4a8db07` | refactor(server) | Every route runs on the Repo; storage backend selection; multi-instance render worker (`SKIP LOCKED`, heartbeats, reaper, cross-instance cancel) |
| 3 | `4944278` | feat(migration) | JSON → PostgreSQL migration: dry run (`plan`), idempotent `migrate`, rollback `export` |
| 4 | `bbbbb1b` | feat(backup) | Encrypted off-site backups (`pg_dump \| age` → S3-compatible), verify, restore into an empty DB, `Dockerfile.backup` |
| 5 | `ee69a67` | test | Phase 2 validation gate (migration, rollback, two instances, backup restore, DB outage) |
| 6 | `a69e4df` | ci(ops) | PostgreSQL 16 service; both backends required in CI; two-instance container smoke; backup image checks |
| 7 | `c1a8dc1` | docs | ADR-001…008, backup/recovery runbook, guest-retention proposal, Phase 2 assessment |
| 8 | `bfe07ec` | fix(db) | **Found by CI:** a connection lost on a checked-out client crashed the process; restore failed for dumps from a newer `pg_dump` |
| 9 | `13e54e5` | docs | Phase 2 CI evidence |
| 10 | `149fcb9` | docs | Independent re-audit (discovery only): found R-02, R-03, R-04, R-11 – R-15 |
| 11 | `101b073` | **fix(db) R-02** | Quota deadlock: lock ordering, reservation ledger (`0002_ai_reservations.sql`), idempotent settle, expiry, safe retry |
| 12 | `7489fad` | **fix(backup) R-11** | DB credentials out of process arguments |
| 13 | `3be15b1` | **fix(server) R-12** | Minimal public probes, cached readiness, gated diagnostics, throttling |
| 14 | `10c4485` | **fix(db) R-14** | Migration-specific timeouts; all-or-nothing, recoverable migrations |
| 15 | `1524c44` | docs | Corrective-round results, abuse proposal, provider comparison, validation standard, ADR-003 correction + ADR-009 |
| 16 | `34b2501` | test | R-12 throttle test: exact token-bucket bound (CI failure was the test's arithmetic) |
| 17 | `6fd474d` | docs | Corrective-round CI evidence |
| 18 | `2ddb147` | docs | This review package; Phase 2.5 plan |
| 19 | `d0d3e6e` | docs | Line-by-line code review (F1–F11); Phase 2.5 design decisions |
| 20 | `97f1907` | test | **Red-first** regression tests for F1–F3, F5, F6 + the backup/restore failure matrix |
| 21 | `af7d58c` | **fix(backup) F1** | Manifest row counts taken from the dump's own snapshot |
| 22 | `168abe3` | **fix(restore) F2** | Restore applied completely or not at all (also: unhandled rejection, back-pressure stall) |
| 23 | `d782ebd` | **fix(restore) F3** | Restore target only from `RESTORE_DATABASE_URL`; runbook recovery procedures |
| 24 | `cf5432b` | **fix(migrations) F6** | Misnamed migration files and duplicate versions are errors |
| 25 | `288149f` | **fix(migrations) F5** | Previous release runs against a newer backward-compatible schema |
| 26 | `7a3add5` | docs | Corrective-round evidence in this package, the code review and the re-audit |
| 27 | `856ddf8` | **fix(migrations)** | The backward-compatible marker is validated (expand-only allow-list); unknown directives are errors |
| 28 | `9f4d4d8` | **fix(restore)** | Exact target state at the COMMIT boundary; read-only `verify-restore`; F1 proof, COMMIT-boundary and F3 credential-scan tests |
| 29 | *(final docs commit)* | docs | Final evidence package (§12) and CI results |

## 2. Changed-file inventory (50 files vs `194f5c5`; ≈ +6,200 / −422)
**Application code**
| File | +/− | Purpose |
|---|---|---|
| `server.ts` | +456 / −321 | Routes on the Repo; backend selection; rate limit + quota reservation lifecycle; render worker; health/ready/details/config; startup/shutdown |
| `server/lib/repo.ts` | +120 | `Repo` interface (storage contract) |
| `server/lib/jsonRepo.ts` | +254 | JSON backend (dev default, rollback target) |
| `server/lib/usage.ts` | +64 / −22 | JSON quota ledger with reservations, persistence, expiry |
| `server/db/pool.ts` | +139 | Pool, TLS policy, safe checkout, `withTx` with deadlock/serialization retry |
| `server/db/pgRepo.ts` | +371 | PostgreSQL backend |
| `server/db/migrate.ts` | +146 | Migration runner (checksums, advisory lock, timeouts, all-or-nothing; F5 newer-compatible schema; F6 file rules) |
| `server/db/migrations/0001_initial.sql` | +102 | Schema |
| `server/db/migrations/0002_ai_reservations.sql` | +18 | Quota reservation ledger |
| `server/db/dataMigration.ts` | +269 | JSON → PostgreSQL migration and rollback export |
| `server/db/offsiteBackup.ts` | +478 | Encrypted off-site backup / verify / restore / prune (F1 snapshot-consistent manifest; F2 atomic restore) |
| `scripts/data-migration.ts`, `scripts/db-backup.ts` | +63, +60 | Operator CLIs (F3: restore target from `RESTORE_DATABASE_URL` only) |
| `scripts/loadtest.ts` | +3 / −3 | Uses gated diagnostics |

**Build, CI, configuration:** `.github/workflows/ci.yml` (+63/−12), `Dockerfile.backup` (+29), `.env.example` (+38),
`package.json` (+6/−1; adds `pg`, `@aws-sdk/client-s3`, `@types/pg`), `bun.lock` (+87), `docker-compose.yml` (+1),
`tsconfig.node.json` (+2), `README.md` (+18/−15).

**Tests (new):** `tests/repo_contract.test.ts` (+323), `tests/phase2.test.ts` (+377), `tests/concurrency.test.ts` (+86),
`tests/hardening.test.ts` (+202), **`tests/backup_restore.test.ts` (+349, F1–F3 + failure matrix)**,
**`tests/migrations.test.ts` (+95, F5/F6)**, and helpers `pg.ts`, `s3Stub.ts`, `tcpProxy.ts`.
**Tests (changed):** `phase1.test.ts`, `api.test.ts`, `ai_workflow.test.ts`, `storage_backup.test.ts`, `e2e/browser.e2e.test.ts`,
`helpers/server.ts`.

**Docs:** `ARCHITECTURE_DECISIONS.md`, `BACKUP_AND_RECOVERY.md`, `RELEASE_REAUDIT.md`, `RELEASE_ASSESSMENT.md`,
`DATABASE_PROVIDER_COMPARISON.md`, `ABUSE_PROTECTION_PROPOSAL.md`, `VALIDATION_STANDARD.md`,
`GUEST_DATA_RETENTION_PROPOSAL.md`, `DATABASE_ARCHITECTURE.md`, `SYSTEM_ARCHITECTURE.md`, `PR3_CODE_REVIEW.md`,
`PHASE2_5_PLAN.md` (plan only), and this file.

**Suggested review order:** `repo.ts` → `0001`/`0002` SQL → `pgRepo.ts` → `pool.ts` → `migrate.ts` → `server.ts`
(rate limit and quota, worker, health) → `offsiteBackup.ts` → `dataMigration.ts` → tests.

## 3. Database transaction design
* **Isolation:** READ COMMITTED everywhere. Correctness comes from row locks and conditional writes, not from
  SERIALIZABLE.
* **Documented lock order per table, followed by every writer:**
  * storage writes: `users` row (`FOR UPDATE`) → `projects` row → `storage_totals('all')` → `storage_totals('guest')`;
  * quota: the call's own `ai_reservations` row → `ai_usage_daily` rows in **ascending key order**;
  * rate limits: `rate_buckets` rows sorted by key;
  * jobs: admission under the user's row lock; claim with `FOR UPDATE SKIP LOCKED`.
* **Atomicity:** each request mutation is a single transaction; quotas and counters are updated in the same
  transaction as the data they describe.
* **Retry:** `withTx` retries SQLSTATE `40P01`/`40001` up to 3 times with jittered backoff. This is safe because
  the server rolled back the whole transaction and the bodies are pure database work. Exhausted retries →
  `503 conflict_retry`. Migrations are never auto-retried.
* **Connection loss:** a checked-out client that loses its connection is logged and destroyed, never an uncaught
  exception. Outage → fast `503 database_unavailable`, readiness 503, automatic recovery.
* **Known limit:** `storage_totals('all')` is a write serialization point (fine at current scale; FS-038).

## 4. Quota settlement lifecycle (R-02)
```
request ──reserve(id)──▶ ai_reservations[id]=reserved ; counters +1 (user, ip)   (all-or-nothing, idempotent per id)
   │
   ├─ real model output, or client aborted ──▶ settle(id, commit)  : reserved → committed (charge kept)
   ├─ fallback / 4xx / 5xx, response complete ─▶ settle(id, refund) : reserved → refunded ; counters −1
   └─ crash / settle failed ──▶ expiry after AI_RESERVATION_TTL_MS (15 min) ──▶ refund
```
* **No double charge:** reserve inserts the reservation first with `ON CONFLICT DO NOTHING`, so a retried reserve
  never increments twice.
* **No double refund:** settle is a conditional `UPDATE … WHERE status = 'reserved'`, so repeated, late or
  expiry-raced settles are no-ops.
* **A failure never consumes quota permanently.** At worst, a successful call whose settle fails is not charged
  (this favours the user).
* **Evidence:** red-first two-instance storm (500s/503s before → 0 after, 3/3 runs); exact charges for mixed
  real/fallback traffic; 200-cycle repository storm; a real `40P01` produced and retried; idempotency and expiry
  contract tests on both backends.

## 5. Backup and restore security
* **Encryption:** `pg_dump` is piped directly into `age` with **public keys only**, so plaintext never touches disk
  and the backup job cannot decrypt. Unencrypted backups are refused.
* **Integrity:** a SHA-256 manifest is written last (a failed backup is never listed); restore refuses a checksum
  mismatch, then verifies row counts.
* **Consistency (F1):** the manifest's row counts are read inside the exported snapshot that `pg_dump --snapshot`
  dumps, so verification is exact under live writes. The backup job needs a direct (or session-mode pooled)
  connection; the snapshot holds back vacuum for the dump's duration.
* **Restore safety:** empty target database only (restore-then-switch). **Atomic (F2):** the tool sends `BEGIN`, and
  `COMMIT` only after decryption, `pg_restore` and the filter all succeeded; any failure, or the tool being killed,
  rolls back. Transaction-control statements inside the stream are refused. A failure *during* COMMIT is reported
  from an inspection of the target. Version-aware filter for newer `pg_dump` output (CI: `pg_dump` 18 → server 16).
* **Credentials:** passed to tools through libpq environment variables, never in argv (R-11), and the restore
  target is read from `RESTORE_DATABASE_URL`, never from the CLI's own arguments (F3).
* **Authenticity (F4, not fixed):** the checksum lives in the same bucket and age encrypts with a public key, so
  bucket write access is enough to plant a restorable backup. Mitigations go into the AWS design: Object Lock,
  write-only backup role, separate account, KMS-signed manifests, restore as a non-superuser.
* **Off-site:** S3-compatible API; `file://` targets are disabled unless explicitly allowed for tests.
* **Pending your decision (§9):** move from age keys to **AWS KMS envelope encryption** (design in
  `DATABASE_PROVIDER_COMPARISON.md` §5). Not implemented in this PR.

## 6. Migration safety
* **Schema migrations:**
  * all pending files apply in one transaction, so a failure leaves the schema unchanged and a re-run recovers;
  * checksummed and append-only;
  * an advisory lock makes concurrent instance start-ups safe;
  * statement and lock timeouts are migration-specific;
  * non-transactional statements are rejected up front;
  * **F6:** a misnamed `*.sql` file or a duplicate version is an error before anything runs;
  * **F5:** a migration may declare `-- forge:backward-compatible` (expand-only, rules in ADR-002). The previous
    release then starts against the newer schema (rolling deploy, rollback) and applies nothing; undeclared newer
    migrations and diverged histories are still refused.
* **Data migration (JSON → PostgreSQL):**
  * refuses corrupt sources and verifies owner plus byte-identical content of every record inside the
    transaction;
  * a dry run leaves nothing behind;
  * re-running is idempotent and keeps newer PostgreSQL writes;
  * rollback exports to a new directory (tested);
  * **the JSON source is never modified or deleted.**

## 7. Test results and CI evidence
| Layer | Local, final code (2026-11-02) | CI on the final head |
|---|---|---|
| Typecheck (`npm run lint`) / production build | ✅ / ✅ | see below |
| JSON backend suite (PG tests required) | **141 tests: 139 pass, 0 fail, 2 skipped** (live Gemini, no key) | see below |
| PostgreSQL suite (every server on PG) | **141: 132 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific, with reasons) | see below |
| Backup/restore + migration rules (19 tests) | 3 consecutive runs: 19/19 each | see below |
| Failure injection (pg_dump / pg_restore dying, corrupt chunk, wrong key, connection killed during backup and restore, orchestrator SIGKILL) | ✅ | see below |
| Multi-instance concurrency (R-02 storms, two-instance gates) | ✅ (inside both suite runs) | see below |
| Browser E2E (JSON, PostgreSQL) | 1/1, 1/1 | see below |
| Docker (two instances on one DB, unsafe configs refused, backup image tools) | n/a (no Docker daemon in this container) | see below |

CI result for the final head: recorded in §11.4 after the run (actual logs inspected, not just the status).

**Not exercised anywhere yet:** real Gemini, a real AWS RDS / S3 / KMS environment, production-sized restore times.

## 8. Operational steps required at merge / deploy time
| Step | Needed when | Notes |
|---|---|---|
| Set `DATABASE_URL` (RDS, `sslmode=verify-full` + RDS CA bundle) or explicitly `STORAGE_BACKEND=json` | Every production start | Production refuses to start otherwise |
| `TRUST_PROXY` (from Phase 1) | Every production start | `1` behind an ALB |
| `HEALTH_DETAILS_TOKEN` (≥ 32 chars, from Secrets Manager) | If monitoring needs diagnostics | Otherwise admins only. **Monitors that read `/api/health` details must switch to `/api/health/details`**; `/api/health` is now liveness only |
| Schema migrations | First start after deploy | Automatic and advisory-locked; or `DATABASE_MIGRATE_ON_START=false` plus a release step |
| JSON → PostgreSQL data cut-over | Only if production JSON data exists | `docs/BACKUP_AND_RECOVERY.md` §6: `plan` → stop JSON server → `migrate` → verify → keep the JSON source 30 days |
| Schedule off-site backups | Before real users | Backup image on a schedule; bucket, keys and alerting per §5 / Phase 4 |
| Load-balancer health checks | Deploy | Liveness `/api/live`, readiness `/api/ready` (cached 1 s, throttled per IP; health-check sources must not share a NAT with heavy traffic) |

## 9. Remaining known risks (not fixed by this PR)
| ID | Sev | Risk |
|---|---|---|
| R-01 | **P0** | Real Gemini generation and the complete render → preview → export journey never demonstrated |
| R-03 | P1 | Guest sign-up budget and guest storage pool can be exhausted (DoS of onboarding) — **Phase 2.5** |
| R-04 | P1 | Guest render jobs starve legitimate users — **Phase 2.5** |
| R-13 | P2 | Memory pressure from concurrent large bodies; 1–6 unexplained dropped sockets — **Phase 2.5** |
| R-05/06/07/18/08/09 | P1 | Fake password reset; Drive identity switch; guest work lost on sign-up; Drive export without video; advertised paid plans; no legal pages or account deletion — Phase 3/4 |
| R-10 | P1 | No AWS infrastructure, CD, staging, monitoring or alerting — Phase 4 |
| FS-037 | P2 | Rendered MP4s are per-instance (needs S3) |
| FS-038/039 | P3 | Hot counter row; a DB round trip per rate-limited request |
| — | P2 | KMS envelope encryption for backups designed, not implemented |
| F4 | P2 | Backup authenticity: bucket write access is enough to plant a restorable backup. Mitigation in the AWS design (Object Lock, write-only role, separate account, signed manifests, non-superuser restore) |
| F7 | P3 | Render minutes billed in a separate statement after `finishJob` (crash between = unbilled render). Folded into Phase 2.5 exactly-once render settlement |
| F8 | P3 | `saveProject` upsert has no owner predicate (not reachable via the API: ids are server-random); update racing a delete re-creates the project |
| F9 | P3 | Data-migration counter rebuild not safe under live writes; run it in the maintenance window (runbook §6) |
| F10 | P3 | Expiry `SKIP LOCKED` is cosmetic (correctness comes from the conditional settle); client abort is charged (your decision) |
| F11 | P3 | `ai_reservations` not in the row-count verification; verify connections take TLS from the URL rather than `tlsConfig` |

## 10. What a reviewer should check by hand
1. `server/db/pgRepo.ts` `reserveAi` / `settleAi` / `expireAiReservations`: same lock order on every path.
2. `server.ts` `rateLimit`: the outcome rule (commit on success or abort; refund on a complete response without
   model output).
3. `server/db/migrate.ts`: `{ attempts: 1 }`, the non-transactional guard, timeouts, **the newer-schema rule (F5)
   and the file-name/duplicate rule (F6)**.
4. `server/db/offsiteBackup.ts`:
   * `createBackup`: the snapshot transaction is opened before `pg_dump`, counted inside, and closed in `finally` (F1);
   * `restoreBackup`: `COMMIT` is written only after `Promise.all([age, pg_restore, filter])` succeeded; every
     failure path kills psql before COMMIT (F2);
   * `libpqEnv`: no URL in argv.
5. `scripts/db-backup.ts` `restore`: refuses extra arguments without echoing them (F3).
6. `server.ts` `hasDiagnosticsAccess`: constant-time compare; 404 for everyone else.
7. CI workflow: `REQUIRE_PG_TESTS=1`, both backend runs, the docker-job 404 assertion.

## 11. Corrective round 2 (2026-11-02): F1, F2, F3, F5, F6
Method per finding: root cause from the code, regression test against the **unfixed** code (red), smallest safe
fix, the same test green, then the full gate. Red-test output was captured before any fix (commit `97f1907`
contains only tests).

### 11.1 Resolution status
| # | Finding | Root cause | Fix | Status |
|---|---|---|---|---|
| F1 | Backup verification fails under traffic | Row counts read on a separate autocommit connection; `pg_dump` took its own later snapshot | One `REPEATABLE READ READ ONLY` transaction; `pg_export_snapshot()`; counts inside it; `pg_dump --snapshot` | **Fixed** (`af7d58c`) |
| F2 | Failed restore commits a partial database | `psql --single-transaction` commits at end of input; a dying upstream stage looks like end of input | Tool-owned transaction: `BEGIN` first, `COMMIT` only after every stage succeeded; kill all stages otherwise | **Fixed** (`168abe3`) |
| F2a *(new, found by the red tests)* | Fast `age` failure → unhandled promise rejection | `serverMajor()` awaited after the children started | Version read before any child starts; every child promise observed | **Fixed** (`168abe3`) |
| F2b *(new, found while fixing)* | Restore hangs forever when psql stops early | Nothing consumed the pipeline any more; back-pressure stalled the filter | psql exiting before its input is ended = failure of the whole pipeline; all stages stopped | **Fixed** (`168abe3`) |
| F3 | Restore target URL (password) in argv | CLI signature `restore <name> <url>` | Target only from `RESTORE_DATABASE_URL`; extra arguments refused, never echoed | **Fixed** (`d782ebd`) |
| F5 | Previous release cannot start against a newer schema | Every unknown applied migration was fatal | `-- forge:backward-compatible` marker recorded in `schema_migrations`; N−1 starts if all unknown migrations are newer **and** compatible | **Fixed** (`288149f`) |
| F6 | Misnamed migration silently skipped; duplicates fail obscurely | The name pattern was used as a filter | Every `*.sql` must match; duplicate versions rejected before anything runs | **Fixed** (`cf5432b`) |

### 11.2 Before / after evidence (same tests, unfixed code vs fixed code)
| Test | Before (unfixed) | After |
|---|---|---|
| F1 backup during a write storm restores `verified:true` (3 backups per run) | **fail**: `verified:false`, manifest ≠ restored counts | pass (6/6 backups in 2 runs, writer confirmed active) |
| F2 pg_restore dies midway → target empty, retry succeeds | **fail**: partial schema committed; retry `relation "ai_reservations" already exists` | pass |
| F2 late decryption failure with a rewritten checksum | **fail**: unhandled rejection | pass: `nothing was committed … age … failed to decrypt and authenticate payload chunk` |
| F2 restore orchestrator SIGKILLed at a statement boundary | **fail**: `actual: 11` tables committed | pass: 0 tables; restarted restore `verified:true` |
| Wrong decryption key (matrix) | **fail**: unhandled rejection | pass: `nothing was committed … no identity matched` |
| F3 target URL as an argument | **fail**: accepted, exit 0 | pass: exit 1, `RESTORE_DATABASE_URL` hint, password not echoed, nothing restored |
| F5 release N−1 against schema N (compatible) | **fail**: `not in this build (newer schema?); refusing to run` | pass: starts, applies nothing, `newerCompatible` reported |
| F5 real server process of N−1 serves reads/writes on schema N | **fail** without the fix (server refuses to start) | pass |
| F6 misnamed file (`9003a_…`, `9003_AddIndex`, `903_…`) | **fail**: silently skipped | pass: error names the file, nothing applied |
| F6 duplicate version | **fail**: raw `schema_migrations_pkey` violation | pass: `duplicate migration version 9004 (9004_a.sql, 9004_b.sql)` before anything runs |

Guards that already held and stay green: interrupted backup (no manifest, nothing listed), connection killed during
backup, connection killed during restore (target empty, retry succeeds), non-empty target refused and untouched,
ownership and every project record identical after two consecutive restores, undeclared newer migration refused,
diverged migration history refused.

### 11.3 Operational changes from this round
* **Restore command changed:** `RESTORE_DATABASE_URL=<empty db> BACKUP_AGE_IDENTITY_FILE=… npm run db-backup -- restore <name>`.
  The old two-argument form is refused.
* **Backup job connection:** direct to PostgreSQL (or a session-mode pooler), not a transaction-mode pooler.
* **Recovery procedures** for every backup/restore failure mode: `docs/BACKUP_AND_RECOVERY.md` §4a.
* **Migrations:** authors add `-- forge:backward-compatible` only to expand-only migrations (ADR-002 rules).
  Existing `0001`/`0002` are unchanged (their checksums must not change).

### 11.4 CI on the final head
*(filled in after the run; see the RELEASE_REAUDIT entry)*

## 12. Final evidence package (answers to the review questions of 2026-11-02)

### 12.1 F1–F6: definitions, root causes, commits
| # | Definition | Root cause | Commits |
|---|---|---|---|
| F1 | A backup's manifest row counts must describe exactly the data inside that backup | Counts were read on a separate autocommit connection (each `count(*)` its own snapshot) **before** `pg_dump` took its own, later snapshot | `af7d58c` |
| F2 | A restore must leave the target either complete or untouched, and the operator must always know which | `psql --single-transaction` commits at end of input; a dying upstream stage (or a killed orchestrator) looks exactly like end of input. Plus F2a: a fast `age` failure became an unhandled rejection; F2b: an early psql exit stalled the pipeline forever; and the state after a failure around COMMIT was reported ambiguously | `168abe3`, `9f4d4d8` |
| F3 | No database credential in any process's arguments, logs or error output | The restore CLI took the target URL (with password) as an argument | `d782ebd` (+ scan test in `9f4d4d8`) |
| F4 | Backups must be authentic, not only intact | Checksum in the same bucket; age encrypts with a public key | **Open**: AWS design (Object Lock, write-only role, separate account, signed manifests) |
| F5 | The previous release must run against a newer schema when (and only when) the newer migrations are backward-compatible | Every applied migration unknown to the build was fatal; afterwards, the compatibility marker was trusted blindly | `288149f`, `856ddf8` |
| F6 | No migration file may ever be skipped or misread silently | The name pattern was used as a filter; duplicate versions unchecked; unknown directives ignored | `cf5432b`, `856ddf8` |

### 12.2 F1: the row counts and pg_dump read the same exported snapshot
* Code path (`createBackup`):
  1. `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
  2. `SELECT pg_export_snapshot()` returns an id;
  3. `countRows()` runs **on that same connection, inside that transaction**;
  4. `pg_dump --snapshot=<id>`. The exporting transaction stays open until `pg_dump` has finished, and is then
     rolled back (it is read-only). PostgreSQL only lets `pg_dump` import the snapshot while that transaction is
     open, so a wrong or expired id makes `pg_dump` fail rather than silently use a new snapshot.
* **Proof test** (`F1 (proof)`):
  * a wrapper records `pg_dump`'s arguments and delays it **1.5 s**, while a writer commits rows (≥ 100) in that window;
  * any new snapshot would contain those rows, and the exported one cannot;
  * fixed code: manifest 11 / dump 11 / late rows in the dump 0 / `verified:true`, and `pg_dump` received
    `--snapshot=<hex>-<hex>-<n>`;
  * **pre-F1 code: manifest 11, dump 197, 186 late rows in the dump, `verified:false`.**

### 12.3 F2: behaviour at every stage, and the exact recovery state
The tool owns the transaction. psql receives `BEGIN;`, then the SQL, then `COMMIT;` **only after** `age`,
`pg_restore` and the filter all exited 0.

| Failure point | What happens | Target state | Message / exit | Operator action |
|---|---|---|---|---|
| Before anything is applied: missing key file, checksum mismatch, non-empty target, bad arguments | Refused before psql starts | Unchanged | Exit 1, specific error | Fix and retry |
| Decryption fails (wrong key; corrupt chunk even with a rewritten checksum) | All stages killed before COMMIT; rollback | **Empty** | `restore aborted, nothing was committed … age … <reason>` | Retry with the right key or backup |
| `pg_restore` / filter fails midway; a transaction-control line appears in the stream | Same | **Empty** | `… nothing was committed … <stage> exited with N` | Retry |
| psql fails midway (SQL error, connection killed) | psql's transaction is aborted; other stages stopped (no stall) | **Empty** | `… nothing was committed …` | Retry |
| The restore process itself is killed (SIGKILL) | psql sees end of input without COMMIT and disconnects; the server rolls back | **Empty** (tested: 0 tables; previously 11 committed) | none (process died) | `verify-restore` → `empty` → retry |
| COMMIT sent, never reached the server | Rolled back | **Empty** | `restore failed; nothing was committed (target database is unchanged)` | Retry (tested) |
| COMMIT took effect, acknowledgement lost | Committed | **Complete** | `restore failed after COMMIT was sent; the target is NOT empty and its row counts MATCH the backup manifest` | `verify-restore` → `complete`; do not restore again (refused anyway) |
| COMMIT outcome where the counts do not match (only if something else wrote to the target) | — | **Mismatch** | `… DO NOT match …; drop and recreate it` | Drop, recreate, retry |
| Completed, but row counts differ from the manifest | Committed | Mismatch | `verified:false`, exit 1 | Do not switch; investigate |

**How an operator verifies the state:** run `RESTORE_DATABASE_URL=<db> npm run db-backup -- verify-restore <name>`.
It is read-only and prints `state` (`empty` | `complete` | `mismatch`) with every differing table; it exits 0 only
for `complete`. Tested for all three states.

### 12.4 F3: no credentials in arguments, logs or error output
* Test `F3 (scan)` uses a real login role with a random password. It samples **every process on the host**
  (`/proc/*/cmdline`) every 10 ms while the CLI runs:
  * `create`;
  * `restore` into a non-empty target;
  * `restore` with the wrong key;
  * `restore` with a failing connection (password in the URL);
  * `restore` with the URL as an argument (refused);
  * a successful `restore`;
  * `verify-restore`.
* Result:
  * no process except the deliberately refused invocation (whose argv the test itself built) ever carried the
    password;
  * no stdout/stderr output contains it;
  * pg tools receive credentials only via libpq environment variables (R-11 test: argv recorded by wrappers
    around the real binaries).
* Server and CLI logs mention only the variable **name** `DATABASE_URL`, never its value. This is by code
  inspection of every log/error site in `server.ts`, `server/db/*` and `scripts/*`; the server's own logs are not
  covered by a runtime scan. Database errors are logged as SQLSTATE plus message, and PostgreSQL error messages do
  not contain passwords.

### 12.5 F5: compatibility rules and how an older build behaves
* **Marker:** `-- forge:backward-compatible`, validated by an allow-list (ADR-002):
  * new tables, and indexes/constraints on them;
  * non-unique indexes;
  * nullable or defaulted `ADD COLUMN`;
  * `COMMENT`;
  * backfill `UPDATE`.

  Anything else in a marked file is an error before anything runs (10 rejection cases tested). The applying build
  records the flag in `schema_migrations.backward_compatible`.

| Database contains, beyond this build's migrations | Older build (with F5) | Build older than F5 |
|---|---|---|
| Only newer migrations, all marked compatible | Starts, applies nothing, logs `schema_newer_than_build` (tested with a real server serving reads and writes) | Refuses to start |
| Any newer migration **not** marked | Refuses: `… was not declared backward-compatible; refusing to run` | Refuses |
| An unknown migration older than this build's newest (diverged history) | Refuses: `… diverged history` | Refuses |
| A known migration whose file changed | Refuses (checksum) | Refuses |

The marker is a claim by the migration author, which the allow-list enforces mechanically. It cannot prove semantic
compatibility (e.g. a backfill `UPDATE` that changes meaning); that remains a code-review responsibility.

### 12.6 F6: malformed file names, duplicates, invalid metadata
| Input | Result (nothing is applied in every case) |
|---|---|
| `9003a_add_index.sql`, `9003_AddIndex.sql`, `903_short.sql` | `<file>: not a valid migration file name (expected NNNN_lower_snake_case.sql)` |
| `9004_a.sql` + `9004_b.sql` | `duplicate migration version 9004 (9004_a.sql, 9004_b.sql)` |
| `-- forge:backwards-compatible`, `-- forge:backward_compatible`, `--forge:compat`, `-- FORGE:backward-compatible` | `<file>: unknown migration directive …` |
| Marked file with a non-expand statement | `<file> is marked backward-compatible but contains a statement that is not expand-only: "…"` |
| `README.md` and other non-SQL files | Ignored |
