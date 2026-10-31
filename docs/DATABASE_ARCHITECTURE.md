# Data / Storage Architecture

There is **no database**. Persistence is JSON files under `DATA_DIR` (default `./data`, `/data` in Docker).

| File | Shape | Key | Notes |
|---|---|---|---|
| `projects.json` | `Project[]` | `id` (`proj_…`), owner `userId` | Field allowlist, ≤512 KB/project, ≤200/user. Sample project lives in code, not in the file |
| `jobs.json` | `ServerJob[]` | `id`, owner `userId` | Capped at 500 entries |
| `subscriptions.json` | `Record<userId, Subscription>` | verified user id | Previously keyed by client IP |
| `renders/render_<32hex>.mp4` | files | random id | Deleted after `RENDER_TTL_HOURS` |
| `.session_secret` | text | – | Dev/test only; production uses `SESSION_SECRET` |

Relationships: `Project.userId → identity`, `ServerJob.userId → identity`, `ServerJob.result.renderId → renders/`.

## Integrity guarantees (implemented)
* **Atomic writes:** write temp file → `rename` (no truncated files on crash). Verified by unit test.
* **Corruption handling:** unparsable files are preserved as `*.corrupt-<timestamp>` instead of being overwritten.
* **Read-modify-write races:** handlers perform synchronous read→modify→write without awaiting in between, so within a
  single Node process updates are serialized by the event loop.

## Limits (not fixed — architectural)
* Whole-file read/write on every request: O(total data). Fine for small deployments; degrades with growth.
* **Single instance only**: two processes sharing `DATA_DIR` would lose updates. Rate limiter, AI daily counters and the
  render queue are also in-memory.
* No migrations, indexes, transactions, or point-in-time backups. Backup = snapshot the `DATA_DIR` volume.
* Migration path: Postgres (projects, jobs, subscriptions tables with `user_id` indexes), Redis (rate limits, queue),
  object storage (renders).

## Legacy data
Records created before this audit without a verified owner (`userId` missing or `default_user`) are no longer
visible to anyone except admins (`ADMIN_USER_IDS` + `GET /api/projects?all=1`). The previously committed
`data/*.json` files (which contained test/user records) were removed from git and `data/` is now ignored.
