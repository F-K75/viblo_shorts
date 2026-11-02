# Architecture Decision Records — Phase 2 (durable architecture)

Each record: context → decision → consequences. "Rejected" lists the alternatives considered.

---

## ADR-001 — PostgreSQL via `node-postgres` with a bounded pool; provider-agnostic

**Context.** Phase 1 storage is single-process JSON files. Production must run more than one instance and
survive instance loss. The approved direction is *managed* PostgreSQL. The provider itself is not chosen yet.

**Decision.**
* Plain PostgreSQL (≥ 14; tested on 16), accessed with `pg` (node-postgres). No ORM.
* One pool per instance: `DATABASE_POOL_MAX` (default 10), connect timeout 5 s, **statement timeout 10 s**
  (a stuck query cannot hold a request forever). Clients that lose their connection, idle or **checked out
  mid-transaction**, are logged and destroyed, never fatal. CI found that a checked-out client's `error` event
  was an uncaught exception that killed the instance during a DB outage; `checkout()` now always attaches a
  listener, and there is a regression test.
* TLS: production uses TLS with certificate verification unless `sslmode=disable` is stated explicitly.
* Backend selection: `DATABASE_URL` ⇒ PostgreSQL. Production **refuses to start** without `DATABASE_URL`,
  unless `STORAGE_BACKEND=json` explicitly accepts single-instance JSON storage.
* Startup waits for the database (10 attempts, exponential backoff), then exits for the orchestrator.

**Consequences.** Any managed provider works (Cloud SQL, RDS/Aurora, Azure, Neon, Supabase, Crunchy…).
Choosing one remains **your decision**; it determines PITR, HA, region and the RPO/RTO you actually get
(docs/BACKUP_AND_RECOVERY.md). Connection count = instances × `DATABASE_POOL_MAX`; use the provider's
pooler (PgBouncer in transaction mode works: the code uses no session state outside transactions) when it
approaches the server's `max_connections`.

**Rejected.** An ORM (Prisma/Drizzle): a heavier dependency and generated client for ~40 queries.
SQLite: rejected by product decision; it cannot be shared by multiple instances anyway.

## ADR-002 — Append-only SQL migrations with checksums and an advisory lock

**Decision.** `server/db/migrations/NNNN_name.sql`, applied in order inside **one** transaction by
`server/db/migrate.ts` at startup (`DATABASE_MIGRATE_ON_START=false` to run them as a separate release step).
`schema_migrations` stores a SHA-256 per file. An edited, already-applied file is a hard error (fix forward).
A file in the database that is missing from the build (a newer schema) is also an error. `pg_advisory_xact_lock`
means concurrent instance start-ups apply each migration exactly once (tested with 3 concurrent runners).

**File rules (F6).** Every `*.sql` file in the directory must be named `NNNN_lower_snake_case.sql` with a unique
version; anything else is an error before anything runs (a misnamed file used to be skipped silently).

**Rolling deploys and rollback (F5).** A migration that the previous release can run against declares it with a
line `-- forge:backward-compatible`; the applying build records that in `schema_migrations.backward_compatible`.
A build that finds applied migrations it does not have starts **only** if all of them are newer than its own
newest migration **and** declared backward-compatible. It then applies nothing and logs
`schema_newer_than_build`. Everything else (an undeclared newer migration, a diverged history) still refuses to
start. A migration may carry the marker only if it is expand-only:
* allowed: new tables, new indexes, new nullable columns, new columns with a default, new constraints that
  existing writes already satisfy;
* never: drop/rename of a table or column, type changes, `NOT NULL` without a default, changed semantics of
  existing data. Those are split into expand (marked) → code change → contract (unmarked, next release).

The application writes with explicit column lists (no `INSERT … VALUES` without columns), which is what makes
added columns safe for the previous release. Tested: tests/migrations.test.ts boots this build against a schema
with an added table and a `NOT NULL DEFAULT` column and serves reads and writes.

**Consequences.** Down-migrations are deliberately absent: rollback = previous image (when the newer migrations
are backward-compatible), otherwise restore or forward fix.

## ADR-003 — Normalized schema around ownership; the API document kept in `jsonb`

**Decision.**
* `users(id, kind, storage_bytes, project_count)`: every owner (firebase / guest / legacy). Quota counters
  live on the user row and are updated **in the same transaction** as the project write, under
  `SELECT … FOR UPDATE` on that row.
* `projects(id, user_id → users, title, doc jsonb, size_bytes, created_at, updated_at)`. The API document is
  stored whole in `doc`, so the existing API contract round-trips unchanged (tested, including unicode and
  nested beats). Ownership, listing and quota fields are real columns.
* `storage_totals('all' | 'guest')` for the guest-pool and global caps.
* `subscriptions`, `jobs`, `ai_usage_daily(day, key)`, `rate_buckets`, `window_counters`, `data_migrations`.
* Indexes follow the actual queries: `projects(user_id, updated_at DESC)` ("my projects"), PK lookups,
  `jobs(user_id, created_at DESC)`, a partial index on active jobs, and `rate_buckets(refilled_at)` for the sweep.

**Concurrency rules.** Lock order for storage writes is always `users → projects → storage_totals('all') →
('guest')`. *Correction (re-audit R-02):* this ADR originally claimed "the code cannot deadlock". **That was
false.** The AI quota path (`ai_usage_daily`) was outside this order: reserve locked `user:` → `ip:` while refund
updated both rows in scan order, and concurrent requests behind one IP deadlocked (500s, lost refunds). Fixed by
ADR-009. The general rule is now: every table has a documented lock order, every writer to a table follows it,
and each pair of writers is covered by a concurrency test (docs/VALIDATION_STANDARD.md). Quotas are exact under concurrency (tested: 20 parallel saves against a cap of 5 ⇒ exactly 5;
counters equal the real row sums).

**Consequences / limits.** The `storage_totals('all')` row is a serialization point for writes that change
total size. That is fine at current scale (sub-millisecond lock hold). If it becomes hot, shard the counter or
enforce the global cap asynchronously. Admin "all projects" is capped at 5,000 rows.

## ADR-004 — Rate limits, guest-mint budget and AI quota in PostgreSQL (not Redis)

**Context.** Limits must hold across instances and restarts.

**Decision.** Store them in the same PostgreSQL database:
* token buckets computed with the **database clock** (consistent across instances), one transaction per request
  touching ≤ 2 rows, all-or-nothing across the user and IP buckets;
* AI quota: a conditional upsert per key inside one transaction (all-or-nothing reservation, refund on fallback);
* hourly guest-mint budget: a fixed-window counter.

**Consequences.** No second stateful service to run, secure, back up and monitor. The cost is about one extra
indexed write per rate-limited request. Revisit (Redis with Lua token buckets) if request volume makes this a
measurable load.
**Rejected.** Redis now: an extra managed dependency for a load the database handles easily. In-memory limits:
they don't hold across instances (FS-008).

## ADR-005 — Data migration: idempotent, verified, dry-runnable, never destructive; rollback by export

**Decision.** `npm run data-migration -- plan | migrate | export <dir>` (server/db/dataMigration.ts).
* Reads the Phase 1 JSON store and **refuses corrupt files** (no partial migrations).
* One transaction under an advisory lock. `INSERT … ON CONFLICT DO NOTHING` means a re-run never overwrites
  rows written in PostgreSQL after go-live; such rows are reported as `diverged` and kept.
* Verification inside the transaction: every source project exists with the **same owner** and a
  byte-identical canonical document. Any missing or wrongly-owned record rolls everything back.
* `plan` runs the whole thing and then rolls back.
* `migrate` first takes a verified JSON snapshot. The JSON source is never modified or deleted.
* Rollback: `export` writes the complete PostgreSQL state into a **new, empty** directory in the Phase 1
  layout and verifies it; then set `STORAGE_BACKEND=json` + `DATA_DIR`. Writes made after go-live are kept
  (tested).

**Source data retention.** Keep the JSON directory and its pre-migration snapshot until (a) at least one
encrypted off-site backup of the migrated database has been restored and verified, and (b) the agreed
observation window has passed (proposal: 30 days). Deleting them needs your explicit approval.

## ADR-006 — Encrypted off-site backups: `pg_dump | age` to S3-compatible storage

**Decision.** `scripts/db-backup.ts` (image: `Dockerfile.backup`, run from the platform's scheduler).
* `pg_dump -Fc` is piped straight into `age` (X25519 public-key encryption), so **plaintext never touches disk**.
  The backup job holds only public keys; the private key is kept offline by operators. A compromised server or
  bucket cannot read backups.
* **Consistent manifest (F1).** The backup holds one `REPEATABLE READ READ ONLY` transaction, exports its
  snapshot, records the per-table row counts inside it, and runs `pg_dump --snapshot=<id>`. Manifest and dump
  describe the same instant, so restore verification is exact even under live traffic (it was not before: every
  backup taken under writes failed verification). The backup job must connect directly or via a session-mode
  pooler.
* The ciphertext goes to `BACKUP_TARGET=s3://bucket/prefix` (AWS S3, R2, B2, GCS interop, MinIO…) with a
  manifest: SHA-256, size, schema version, per-table row counts. The manifest is written last, so a listed
  backup is complete.
* Restore verifies the checksum, decrypts, converts with `pg_restore -f -` to SQL, drops only header session
  settings the target server does not know, and applies it with `psql -v ON_ERROR_STOP=1` inside one transaction
  into an **empty** database. It then verifies row counts, and you switch `DATABASE_URL` (restore-then-switch,
  never in place). **Atomicity (F2):** the tool, not psql, owns the transaction. It sends `BEGIN` first and
  `COMMIT` only after decryption, `pg_restore` and the filter have all exited successfully; any failure, or
  the tool itself being killed, ends without `COMMIT` and the server rolls back. (`psql --single-transaction`
  was used before and committed a partial restore whenever an upstream stage died, because that looks like end
  of input.) The target URL is read from `RESTORE_DATABASE_URL`, never from the command line (F3). Why the SQL path: `pg_dump` must be ≥ the server version, but a newer `pg_dump` (17+) writes
  `SET transaction_timeout`, which a 16 server rejects. CI caught this with `pg_dump` 18 against server 16; a
  direct `pg_restore` aborted. Every other error aborts the restore with nothing committed (tested failure
  matrix: tests/backup_restore.test.ts).
* `file://` targets are disabled unless `BACKUP_ALLOW_FILE_TARGET=1` (tests, or a mounted *remote* filesystem).
  Same-disk backups are never the only copy.
* Recommended bucket settings: versioning plus object lock (immutability), a lifecycle rule for retention, and a
  region/provider different from the database.

**Complementary.** Provider PITR (point-in-time recovery from WAL) is the primary tool for "undo the last hour".
Logical dumps are the off-site, provider-independent copy.

## ADR-007 — Job queue in PostgreSQL: `SKIP LOCKED` claims, heartbeats, reaper

**Decision.** Any instance claims the oldest queued job with `FOR UPDATE SKIP LOCKED`, so no job is handed
out twice (tested: 15 concurrent claims for 10 jobs). A processing job carries `worker_id` + `heartbeat_at`.
Workers heartbeat every second and observe cancellation through the heartbeat, killing ffmpeg even when the
cancel arrived at another instance (tested). Jobs whose heartbeat is older than `JOB_STALE_MS` (30 s) are
failed honestly by a reaper on any instance. Admission (5 active jobs, render minutes including those reserved
by queued jobs) is evaluated **atomically with the insert** under the user's row lock (tested: 12 concurrent
creates across 2 instances ⇒ exactly 5 accepted).

**Known limit (FS-037).** Rendered MP4 files are written to the local disk of the instance that rendered them.
Behind a load balancer without sticky routing, `/api/render/download/:id` can hit an instance without the file
(404). The UI does not use server renders today. The fix is object storage for renders (Phase 4, together with
CDN delivery).

## ADR-008 — JSON backend kept (development default, rollback target)

**Decision.** `JsonRepo` keeps Phase 1 behaviour unchanged and passes the same contract tests as
`PostgresRepo` (tests/repo_contract.test.ts). It is the zero-dependency development default and the rollback
target of ADR-005. In production it must be selected explicitly and is single-instance only.

## ADR-009 — AI quota reservation ledger and transaction retry (R-02)

**Context.** The re-audit reproduced `deadlock detected` between quota reservation and refund (3/45 requests),
with failed refunds charging users for fallbacks.

**Decision.**
* One global lock order on the quota path: the call's own `ai_reservations` row, then `ai_usage_daily` rows in
  **ascending key order**, for reserve, settle and expiry alike.
* `ai_reservations(id, day, keys, status reserved|committed|refunded)`. Reserve inserts the row first
  (`ON CONFLICT DO NOTHING`, so a retried reserve with the same id is a no-op) and then increments the counters.
  Settle is a conditional `reserved → committed|refunded` transition, so a duplicate settle is a no-op and
  nothing is ever double-refunded or double-charged. Only refunds decrement.
* Outcome rule: real model output or a client abort → commit; a complete response without model output
  (fallback, 4xx/5xx) → refund. Reservations never settled (crash, failed settle) are refunded after
  `AI_RESERVATION_TTL_MS` (15 min). A failure cannot consume quota permanently; at worst a successful call is
  not charged.
* `withTx` retries `40P01`/`40001` (≤ 3 attempts, jittered). This is safe because the server rolled the
  transaction back and transaction bodies are pure DB work. Exhausted retries → `503 conflict_retry`. Migrations
  are never auto-retried.

**Evidence.** Red-first HTTP storm (2 instances, 80 concurrent fallbacks from one IP): 500s/503s before, 0 after
(3/3 runs). Repository storm of 200 reserve→settle cycles: 0 errors, exact counters. A real `40P01` is produced and
retried in a test.

## Not done in Phase 2 (and why)
* **Provider selection and provisioning** — needs your decision (cost, region, compliance); no infrastructure
  was created.
* **PITR** — a provider feature; configured with the provider, not in this repository. It is not testable here.
* **Object storage for renders** — Phase 4 (FS-037).
* **Guest data retention** — proposal only (docs/GUEST_DATA_RETENTION_PROPOSAL.md); nothing is deleted.
