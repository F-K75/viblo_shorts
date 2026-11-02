# Data / Storage Architecture

> Phase 1 (interim) layout. PostgreSQL replaces it in Phase 2; until then the server is **single-instance only**.

There is no database. Persistence is JSON files under `DATA_DIR` (default `./data`, `/data` in Docker).

| Path | Shape | Notes |
|---|---|---|
| `projects/<userId>.json` | `{ v: 1, userId, projects: Project[] }` | One shard per user (ids that are not `[A-Za-z0-9_-]` use `x_<sha256>`). A request reads **only its own shard** |
| `projects.migrated.json` | marker | Written after the one-time migration from the legacy single file (or on a fresh store) |
| `projects.json.migrated-<ts>` | legacy | The pre-Phase-1 single file, renamed after a verified migration and **never deleted** |
| `jobs.json` | `ServerJob[]` | Capped at 500 entries |
| `subscriptions.json` | `Record<userId, Subscription>` | Rows exist only for users with state (render minutes, demo plan); the default free plan is computed |
| `usage.json` | `{ v, day, counts }` | Daily AI usage per user and per IP; flushed ≤1 s after change and on shutdown |
| `renders/render_<32hex>.mp4` | files | Deleted after `RENDER_TTL_HOURS` |
| `backups/snap-*/` | snapshot + `manifest.json` | See "Backups" |
| `.server.lock` | `{ pid, hostname, startedAt }` | Lets the restore tool refuse to run while the server is up |
| `.restore-in-progress.json` | restore journal | Exists only while a restore runs or after one was interrupted; the server refuses to start while it exists (run `npm run backup -- recover`) |

In memory: a `projectId → owner` index (built at boot) and per-shard sizes for quota accounting.

## Integrity guarantees (tested)
* **Atomic, durable writes:** temp file → `fsync` → `rename` → directory `fsync`.
* **Fail closed on corruption:** an unparsable file is never treated as empty. The affected scope answers
  `503 store_unavailable` and nothing is written over it. One forensic copy (`*.corrupt-<ts>`) is kept per
  file version. A corrupt user shard affects only that user; a corrupt shared store (`jobs.json`,
  `subscriptions.json`, `usage.json`, or the legacy file) also turns `/api/ready` to 503.
* **Verified migration:** a pre-migration snapshot is taken and re-hashed, every record is written to its
  shard and read back, the record count is compared, and only then is the legacy file renamed.
* **Read-modify-write races:** handlers do read → modify → write synchronously, so updates are serialized by
  the event loop **within one process**.

## Limits (abuse protection, all configurable — see `.env.example`)
| Limit | Default | Response |
|---|---|---|
| Request body | 1 MB | 413 |
| Single project | 512 KB | 413 `project_too_large` |
| Guest: projects / bytes | 10 / 5 MB | 409 `project_limit` / `storage_quota_exceeded` |
| Signed-in user: projects / bytes | 200 / 25 MB | 409 |
| All guests together | 512 MB | 507 `guest_storage_full` (signed-in users unaffected) |
| Whole store | 4 GB | 507 `storage_full` |
| Free disk floor | 256 MB | 507 `storage_full` |
| New guest sessions | 10/min/IP and 1000/hour globally | 429 `guest_capacity` |

Limits only block **growth**: users already above a limit can still edit (same or smaller size) and delete.

## Backups
* Verified snapshot of every store file at boot and every `BACKUP_INTERVAL_HOURS` (default 6). The newest
  `BACKUP_RETENTION` (28) scheduled snapshots are kept. `pre-migration`, `pre-restore` and `manual`
  snapshots are never pruned automatically.
* `npm run backup -- create | list | verify <name> | restore <name> [--force] [--allow-unparseable] | recover`.
* **Restore is all-or-nothing (J1).** In order:
  1. refuse a snapshot that does not verify, or one containing unparseable store files (unless
     `--allow-unparseable`);
  2. refuse while the server is running. `--force` only overrides a lock written by another host/container, never
     a provably running local server;
  3. create the restore journal exclusively (a second restore refuses);
  4. take a `pre-restore` snapshot;
  5. copy the snapshot into `.restore-staging-<ts>/` and verify the staged copy (size + SHA-256 of every file,
     every store file parses). Any failure up to here changes nothing: `restore aborted, nothing was changed`;
  6. swap: each live entry is renamed aside (`*.pre-restore-<ts>`, never deleted) and the staged entry renamed into
     place;
  7. any failure during the swap is **rolled back automatically**: the originals are renamed back, and restored
     entries are kept in `.restore-failed-<ts>/`. Message: `rolled back automatically; the live data is exactly
     as before`;
  8. if even the rollback fails, the journal stays, **the server refuses to start**, and `npm run backup --
     recover` finishes the rollback. It is idempotent and also covers a restore process that was killed.
* **Server/restore exclusion:** the server writes `.server.lock` and then checks the journal before opening any
  store. A restore creates the journal and then re-checks the lock. Whichever starts second sees the other and
  backs off, so the server can never observe a partially restored directory.
* **Remaining limitations (J1):**
  * the swap is atomic per entry (rename), not across all entries; atomicity of the whole set comes from the
    journal, the server guard and the rollback;
  * a power loss in the middle of the swap is recovered by `recover` (renames are durable, the journal is
    fsynced). On filesystems without directory fsync the last rename may need `recover` to be re-run;
  * the old `--force` behaviour against a live local server is gone on purpose.
* **Snapshot consistency (J2, open finding):** scheduled snapshots are taken by the server synchronously inside its
  event loop, and the stores are written synchronously, so they are a consistent point-in-time copy of all files.
  `npm run backup -- create` from the CLI **while the server is running** copies files one at a time. Each file is
  internally consistent (atomic writes), but different files may be from slightly different moments (e.g.
  `usage.json` vs a project shard). Until the required guarantee is decided, the supported workflow for a
  point-in-time CLI snapshot is to take it with the server stopped, or to use the server's scheduled snapshots.
* **Limitation:** `BACKUP_DIR` defaults to the same volume. Copy snapshots off-host until Phase 2 (managed
  PostgreSQL backups + PITR).

## Not solved in Phase 1 (architectural)
* Single instance only (shards, index, usage ledger and rate limits are per process).
* Admin `GET /api/projects?all=1` reads every shard (O(total data)).
* No retention for guest data: guest shards stay after the 30-day guest token expires (they are unreachable
  then). Growth is bounded by the guest pool cap; a retention policy needs a product decision.
* Migration path (Phase 2): PostgreSQL (`projects`, `jobs`, `subscriptions`, `ai_usage` with `user_id`
  indexes), Redis or PostgreSQL for rate limits, object storage for renders.
