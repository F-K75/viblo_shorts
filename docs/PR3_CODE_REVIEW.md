# PR #3 Code Review: Diff, Migrations, Backup/Restore, Quota Transactions

> Scope: the actual diff `194f5c5..2ddb147` (47 files; 45 code/test/config files plus 2 review docs).
> I read it line by line, focusing on `server/db/*`, `server/db/migrations/*`, `server/lib/repo.ts`,
> the quota and job paths in `server.ts`, and `scripts/db-backup.ts`.
> Method: read the code, then reproduce each suspected defect against PostgreSQL 16 before listing it as
> confirmed. **[R]** = reproduced in this session · **[A]** = by code analysis, not yet reproduced.
> **Result: PR #3 is not ready to merge.** Two P1 defects in the backup/restore path were found and reproduced.
> They were not caught by the existing tests, because those tests take backups of an idle database and never
> fail a restore stage midway.

## 1. Findings

| # | Sev | Area | Finding | Evidence |
|---|---|---|---|---|
| F1 | **P1** | Backup | **Manifest row counts are not taken from the dump's snapshot.** `createBackup` counts rows with a separate connection, then starts `pg_dump`, which takes its own snapshot later. Any write in between makes the manifest disagree with the dump, so **every restore of a backup taken under traffic reports `verified:false` and the CLI exits 1.** The verification signal is useless in production, and operators would learn to ignore it. | **[R] 3/3.** A writer inserting during backup gave manifest/restored counts of 341/422, 917/1010 and 1561/1676, all `verified:false`. |
| F2 | **P1** | Restore | **A failed stage can commit a partial restore.** `psql --single-transaction` sends `COMMIT` at end of input. If `age -d` or `pg_restore` dies midway, psql sees EOF and **commits what it received**, then `restoreBackup` throws. ADR-006's claim that "no partial restore is left behind" is **false**. The target is a fresh database and is never switched automatically, so production is not at risk. But the drill leaves a half-restored database that the empty-target guard then refuses to reuse. | **[R]** The upstream exited 3, psql exited 0, and 2 rows were committed. |
| F3 | P2 | R-11 residual | `db-backup restore <name> <emptyDbUrl>` takes the **target URL, including its password, as a command-line argument** of the Node process, which is readable via `ps` and `/proc/*/cmdline`. R-11 removed credentials from the arguments of pg_dump/psql but not from this CLI's own arguments. | [A] `scripts/db-backup.ts:6,33` |
| F4 | P2 | Backup authenticity | Integrity relies only on a SHA-256 stored **in the same bucket**. age encryption uses the *public* key, so anyone with bucket write access can plant a validly encrypted dump plus a matching manifest. Restore then executes its SQL as the restore user. | [A] |
| F5 | P2 | Migrations | The runner **refuses to start any build when the database has a newer migration** (`migrate.ts:85`). During a rolling deploy, an old instance that restarts, or a rollback to the previous image, cannot boot after the new release migrated. That contradicts ADR-002's expand→migrate→contract promise. | [A] `migrate.ts:83-87` |
| F6 | P3 | Migrations | Any `.sql` file whose name does not match `^\d{4}_[a-z0-9_]+\.sql$` is **silently ignored** (e.g. `0003a_x.sql` or `0003_Add.sql`). Duplicate version numbers are not rejected up front; they fail later with a confusing primary-key error. (My own Phase 2.5 plan named migrations `0003a`/`0003b`, which would have been skipped. The plan is corrected.) | [A] `migrate.ts:47` |
| F7 | P3 | Render billing | `finishJob` and `addRenderMinutes` are **two separate statements**. A crash between them leaves a completed render unbilled. That is an under-charge, never an over-charge. Render minutes have no ledger, unlike AI quota. Phase 2.5 requires exactly-once settlement including crashes and needs this fixed. | [A] `server.ts:1472-1474` |
| F8 | P3 | Projects | `saveProject`'s `ON CONFLICT (id) DO UPDATE` has no `WHERE projects.user_id = EXCLUDED.user_id`. It is not exploitable through the API, because new ids are server-random. But a cross-user id collision would overwrite another user's document and drift counters. Separately, an update racing a delete by the same user re-creates the deleted project. | [A] `pgRepo.ts:109-113`, `server.ts:1229-1236` |
| F9 | P3 | Data migration | The counter rebuild (`UPDATE users … FROM (sum…)`) is not safe against concurrent live writes, although ADR-005 describes re-running after go-live. It also runs under the request pool's 10 s statement timeout, so a large dataset fails (safely, by rolling back) and needs `DATABASE_STATEMENT_TIMEOUT_MS` raised. | [A] `dataMigration.ts` |
| F10 | P3 | AI quota | `expireAiReservations` runs its `SELECT … FOR UPDATE SKIP LOCKED` in autocommit, so the lock is released at once. **Correctness still holds**, because settling is a conditional `reserved→*` transition, but the comment overstates it. A client abort is settled as *commit*, so a user can be charged for a call aborted before the model ran. This is a documented trade-off, so you should decide whether you accept it. | [A] `pgRepo.ts:217-227`, `server.ts:362` |
| F11 | P3 | Backup | `BACKUP_TABLES` omits `ai_reservations`, which is dumped but not verified. `rowCounts`/`serverMajor` open connections that bypass `tlsConfig` (TLS taken from the URL by `pg`, not by our policy). | [A] |

### Checked and found correct
* **Quota transactions (R-02):**
  * reserve inserts the ledger row first;
  * counters are updated with a conditional upsert in sorted key order;
  * settle is a conditional transition, so it is exactly-once;
  * refunds lock rows in the same sorted order;
  * expiry is safe against concurrent settle;
  * a failed reserve rolls back its ledger row;
  * `withTx` retries only `40P01`/`40001` and never retries on a broken connection.
* **Project quota transactions:** users→projects→storage_totals('all')→('guest') lock order on every writer; limits checked before the counter update; a 507 rolls back the whole transaction.
* **Job queue:**
  * the `SKIP LOCKED` claim is a single statement;
  * `finishJob` and heartbeat are guarded by `worker_id` and status;
  * cancel works cross-instance;
  * admission runs under the user row lock.
* **Migrations:** one transaction, advisory lock, `SET LOCAL` timeouts (integer-floored, so the interpolation is safe), checksums, rejection of statements that can't run inside a transaction, and `attempts: 1`.
* **Backup:** plaintext never reaches disk; recipients are validated as `age1…`; temp directories are cleaned in `finally`; the restore is gated on an empty target and decrypts only after the checksum matches.
* **Error mapping:** async errors reach the central handler via `forwardErrors`; conflicts give 503 `conflict_retry` and database outages give 503 `database_unavailable`.

## 2. Recommended disposition
**Fix F1, F2 and F3 inside PR #3 before merge.** Backup and restore are Phase 2 deliverables, and shipping them with
broken verification would make the RPO/RTO claims unverifiable. **Ideally fix F5 and F6 there too.** F4 goes into the AWS
design (Phase 4 prep). F7 is folded into Phase 2.5, since it falls under the exactly-once render settlement requirement.
F8–F11 are small hardening items that can go in PR #3 or a follow-up, as you choose.

Proposed fixes, each with a red-first test:

| # | Fix | Red-first test |
|---|---|---|
| F1 | Open a `REPEATABLE READ` transaction, call `pg_export_snapshot()`, count rows inside it, run `pg_dump --snapshot=<id>` while it stays open | Backup during a write storm restores with `verified:true` (fails today, as reproduced above) |
| F2 | Drop `--single-transaction`. Stream `BEGIN;` + SQL to psql and append `COMMIT;` **only after** `age` and `pg_restore` both exit 0; otherwise kill psql, which rolls back | Inject a `pg_restore` failure midway; the target stays empty |
| F3 | Read the target from the `RESTORE_DATABASE_URL` environment variable; reject a URL passed as an argument | The argv wrapper test (as used for R-11) sees no password |
| F5 | The runner accepts newer applied versions when `MIGRATIONS_ALLOW_NEWER=1` (one release back, read-only check), or migrations move to a separate release job, and app start-up only verifies | Boot release N-1 against schema N |
| F6 | Fail on any `*.sql` not matching the pattern, and on duplicate versions | Misnamed and duplicate files make `migrate` throw |

## 3. Final review checklist (for you)

**Prerequisites**
- [ ] PR #2 is reviewed and merged into `main`; then PR #3 is retargeted to `main` and re-run green.
- [ ] F1–F3 (and F5/F6 if accepted) are fixed with red→green evidence and CI green on the new head.

**Diff review**
- [ ] `server/db/migrations/0001_initial.sql`, `0002_ai_reservations.sql`: constraints, `ON DELETE` behaviour (projects `RESTRICT`, jobs/subscriptions `CASCADE`), indexes against the queries in `pgRepo.ts`.
- [ ] `server/db/migrate.ts`: single transaction, checksum rule, newer-schema rule (F5), file-name rule (F6).
- [ ] `server/db/pool.ts`: TLS policy (`sslmode` handling), `checkout()` error listener, retry set limited to 40P01/40001.
- [ ] `server/db/pgRepo.ts`: lock order comments match the code; `reserveAi`/`settleAi`/`expireAiReservations`; `saveProject` (F8).
- [ ] `server.ts` `rateLimit`: reservation id per call, settle on `close`, commit-on-abort trade-off (F10).
- [ ] `server/db/offsiteBackup.ts` + `scripts/db-backup.ts`: F1–F4, F11.
- [ ] `server/db/dataMigration.ts`: verification inside the transaction, dry-run rollback, F9.
- [ ] Tests: `repo_contract`, `concurrency`, `phase2`, `hardening`. Each assertion should fail if the protection were removed (see VALIDATION_STANDARD).

**Operations (before any production use)**
- [ ] `DATABASE_URL` with `sslmode=verify-full` and the RDS CA; `TRUST_PROXY` set to the ALB hop count.
- [ ] `HEALTH_DETAILS_TOKEN` (≥ 32 chars) in Secrets Manager; monitors use `/api/health/details`; the load balancer uses `/api/live` and `/api/ready`.
- [ ] Backup bucket in a separate account/region with Object Lock; a write-only role for the backup job; the age private key held offline by two operators.
- [ ] One restore drill into an empty database **under write load**, after F1, with `verified:true` and timings recorded against RTO 4 h.
- [ ] Data cut-over runbook: `plan` → snapshot → `migrate` with the app in maintenance mode (F9) → verify → switch.

## 4. Unresolved technical concerns (not defects in PR #3)
1. **PITR / Multi-AZ** cannot be tested here. RPO 15 min depends on RDS configuration (Phase 4).
2. **Rendered files on local disk (FS-037)**: downloads can 404 behind a load balancer without sticky routing until renders move to S3.
3. **Browser export is unverified.** The previous audit found the Drive export broken. No claim that browser export
   produces a playable MP4 will be made until an exported file has been verified with ffprobe and playback (this is
   part of the live-Gemini release blocker).
4. **Real Gemini end-to-end** remains a separate release blocker (no mocked responses).
5. The release score (55) predates F1/F2. It is **provisional**, and I will rescore it after the fixes.
