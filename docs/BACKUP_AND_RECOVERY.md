# Backup, Recovery, RPO / RTO and Cut-over Runbook

> Applies to the PostgreSQL backend (Phase 2). The single-instance JSON backend keeps its Phase 1 on-volume
> snapshots (docs/DATABASE_ARCHITECTURE.md). **Same-disk backups are never the only copy.**

## 1. Protection layers

| Layer | What | Protects against | Where |
|---|---|---|---|
| L1 Provider HA | Synchronous standby / regional failover | Instance or zone failure | Managed provider (configure) |
| L2 Provider PITR | Continuous WAL archive + base backups | "Undo the last N minutes" (bad deploy, accidental delete) | Managed provider (configure, retention ≥ 7 days) |
| L3 Encrypted off-site logical backups | `pg_dump -Fc \| age` → S3-compatible bucket in **another provider or region** | Provider/account loss, ransomware, deleted cluster, long-term retention | `Dockerfile.backup` + platform scheduler |
| L4 Pre-change snapshots | JSON snapshot before migration; `db-backup create` before risky releases | Migration / release mistakes | Operator runbook (below) |

L3 is implemented and tested in this repository. **L1/L2 are provider settings: they cannot be enabled or
tested from here until you choose a provider.**

## 2. RPO / RTO

| Scenario | RPO (data loss) | RTO (time to recover) | Basis |
|---|---|---|---|
| Instance crash | 0 | ≈ restart time (seconds) | Stateless app; jobs of a dead instance reaped after 30 s |
| DB primary failure, provider HA on | 0–seconds (provider SLA) | 1–2 min (provider failover) | Provider documentation — **to be confirmed for the chosen provider** |
| Logical error (bad delete), provider PITR on | minutes (WAL archive lag, typically ≤ 5 min) | provider restore time + switch (~15–60 min, size-dependent) | Provider documentation |
| Provider/account loss, PITR unavailable | **≤ backup interval** (proposed: 1 h → RPO ≤ 1 h) | download + decrypt + `pg_restore` + switch | Measured below |
| Without provider PITR (L3 only) | ≤ backup interval for every scenario | as above | — |

**Measured (this sandbox, PostgreSQL 16, test dataset):** encrypted backup + upload and restore with row-count
verification works end to end. Restore into an empty database took **166 ms** (download 12 ms, `pg_restore`
154 ms) for a tiny dataset. This proves the procedure, not the production RTO. `pg_restore` time grows roughly
linearly with data size: **measure on a production-sized copy before launch** and record the number here.

**Proposed targets for launch (need your approval):** RPO ≤ 5 min (PITR) / ≤ 1 h (off-site);
RTO ≤ 1 h for a full off-site restore. Backup schedule: hourly `db-backup create` (or every 6 h if PITR is
on), keep hourly for 48 h, daily for 35 days, monthly for 12 months (bucket lifecycle rules).

## 3. Off-site backup setup
1. Generate an age keypair **offline**: `age-keygen -o forge-backup-key.txt`. Store the private key in two
   separate secure places (e.g. a password manager vault and a sealed offline copy). Never put it on servers.
2. Bucket: a separate account/provider or region from the database; versioning + object lock (compliance
   mode) + lifecycle rules; a write-only (PutObject/List) credential for the backup job.
3. Schedule the backup image:
   ```bash
   docker run --rm --env-file backup.env forge-backup create
   ```
   `backup.env` needs `DATABASE_URL` (a read-only role is enough for `pg_dump`), `BACKUP_TARGET=s3://bucket/prefix`,
   `S3_ENDPOINT` (non-AWS), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `BACKUP_AGE_RECIPIENTS=age1…`.
4. Alert when no new manifest has appeared for 2 × the interval (Phase 4 monitoring).

## 4. Restore procedure (tested: tests/phase2.test.ts "Gate 8")
1. `npm run db-backup -- list` → pick the backup; `npm run db-backup -- verify <name>` (checksum only).
2. Create a **new empty** database (never restore over the live one).
3. `BACKUP_AGE_IDENTITY_FILE=/secure/forge-backup-key.txt npm run db-backup -- restore <name> <new-db-url>`.
   It refuses a non-empty target or a checksum mismatch, applies everything in ONE transaction (all or
   nothing), works when the backup tool is newer than the target server (unknown session settings are dropped),
   and prints row counts versus the manifest plus timings.
4. Smoke-test the app against the new database (staging instance), then switch `DATABASE_URL` and roll the
   instances. Keep the old database until the incident is closed.

## 5. Database outage behaviour (tested: "Gate 9")
* Requests fail fast with `503 database_unavailable` (connect timeout 5 s, statement timeout 10 s). Nothing is
  half-written: every write is one transaction.
* `/api/ready` returns 503, so the load balancer stops routing to the instance; `/api/health` stays 200 for
  liveness.
* When the database is back, the pool reconnects automatically. No restart is needed.

## 6. Cut-over runbook: JSON → PostgreSQL
1. **Rehearse on staging** with a copy of production `DATA_DIR`: `npm run data-migration -- plan` (dry run;
   changes nothing) and check `verification.ok` and the source counts.
2. Announce a short write freeze; stop the JSON server (the migration refuses to run while it holds the lock).
3. `npm run data-migration -- migrate`: takes a verified JSON snapshot, migrates in one transaction, verifies
   owner + content of every record, and rolls back on any mismatch.
4. Start the app with `DATABASE_URL`; smoke test (sign-in, list projects, save, guest flow).
5. Run `npm run db-backup -- create` and **restore it into a scratch database** (§4) — this satisfies the
   source-retention condition of ADR-005.
6. Keep the JSON directory and snapshot read-only for the observation window (proposed 30 days).

**Rollback** (any time during the window, tested):
1. Stop the PostgreSQL instances.
2. `npm run data-migration -- export /new/empty/dir`: verified export including writes made after go-live.
3. Start the app with `STORAGE_BACKEND=json DATA_DIR=/new/empty/dir` (single instance).

Re-running `migrate` is safe: it is idempotent and never overwrites newer PostgreSQL rows (reported as `diverged`).
