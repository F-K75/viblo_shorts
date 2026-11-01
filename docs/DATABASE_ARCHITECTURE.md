# Data / Storage Architecture

> **This document describes the JSON backend** (`STORAGE_BACKEND=json`: development default, rollback target,
> single instance only). Production uses PostgreSQL: schema in `server/db/migrations/`, decisions in
> [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md), backups in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).

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
* `npm run backup -- create | list | verify <name> | restore <name> [--force]`.
* Restore refuses a snapshot that does not verify, and refuses while the server is running. It first takes a
  `pre-restore` snapshot and moves the current files aside (`*.pre-restore-<ts>`) — nothing is deleted.
* **Limitation:** `BACKUP_DIR` defaults to the same volume. Copy snapshots off-host until Phase 2 (managed
  PostgreSQL backups + PITR).

## Not solved in Phase 1 (architectural)
* Single instance only (shards, index, usage ledger and rate limits are per process).
* Admin `GET /api/projects?all=1` reads every shard (O(total data)).
* No retention for guest data: guest shards stay after the 30-day guest token expires (they are unreachable
  then). Growth is bounded by the guest pool cap; a retention policy needs a product decision.
* Migration path (Phase 2): PostgreSQL (`projects`, `jobs`, `subscriptions`, `ai_usage` with `user_id`
  indexes), Redis or PostgreSQL for rate limits, object storage for renders.
