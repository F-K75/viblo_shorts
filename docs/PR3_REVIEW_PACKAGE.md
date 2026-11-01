# PR #3 Review Package — Phase 2 (durable architecture) + corrective round

**PR:** [F-K75/viblo_shorts#3](https://github.com/F-K75/viblo_shorts/pull/3) · **Head:** `6fd474d` · **Base:** Phase 1 branch
`claude/keen-feynman-xtbvz2` @ `194f5c5` (PR #2, not yet merged) · **CI:** green on `6fd474d`
([run 41340655795](https://github.com/F-K75/viblo_shorts/actions/runs/41340655795)) · **Status:** awaiting your review.
**Not merged, not deployed. No infrastructure created.**

**Merge prerequisite:** PR #2 (Phase 1) merges first. Then this PR is retargeted to `main`; its diff stays the same
because it is stacked on #2.

---

## 1. Commit summary (17 commits, in order)
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

## 2. Changed-file inventory (45 files, +4,922 / −422)
**Application code**
| File | +/− | Purpose |
|---|---|---|
| `server.ts` | +456 / −321 | Routes on the Repo; backend selection; rate limit + quota reservation lifecycle; render worker; health/ready/details/config; startup/shutdown |
| `server/lib/repo.ts` | +120 | `Repo` interface (storage contract) |
| `server/lib/jsonRepo.ts` | +254 | JSON backend (dev default, rollback target) |
| `server/lib/usage.ts` | +64 / −22 | JSON quota ledger with reservations, persistence, expiry |
| `server/db/pool.ts` | +139 | Pool, TLS policy, safe checkout, `withTx` with deadlock/serialization retry |
| `server/db/pgRepo.ts` | +371 | PostgreSQL backend |
| `server/db/migrate.ts` | +104 | Migration runner (checksums, advisory lock, timeouts, all-or-nothing) |
| `server/db/migrations/0001_initial.sql` | +102 | Schema |
| `server/db/migrations/0002_ai_reservations.sql` | +18 | Quota reservation ledger |
| `server/db/dataMigration.ts` | +269 | JSON → PostgreSQL migration and rollback export |
| `server/db/offsiteBackup.ts` | +391 | Encrypted off-site backup / verify / restore / prune |
| `scripts/data-migration.ts`, `scripts/db-backup.ts` | +63, +51 | Operator CLIs |
| `scripts/loadtest.ts` | +3 / −3 | Uses gated diagnostics |

**Build, CI, configuration:** `.github/workflows/ci.yml` (+63/−12), `Dockerfile.backup` (+29), `.env.example` (+38),
`package.json` (+6/−1; adds `pg`, `@aws-sdk/client-s3`, `@types/pg`), `bun.lock` (+87), `docker-compose.yml` (+1),
`tsconfig.node.json` (+2), `README.md` (+18/−15).

**Tests (new):** `tests/repo_contract.test.ts` (+323), `tests/phase2.test.ts` (+377), `tests/concurrency.test.ts` (+86),
`tests/hardening.test.ts` (+202), and helpers `pg.ts`, `s3Stub.ts`, `tcpProxy.ts`.
**Tests (changed):** `phase1.test.ts`, `api.test.ts`, `ai_workflow.test.ts`, `storage_backup.test.ts`, `e2e/browser.e2e.test.ts`,
`helpers/server.ts`.

**Docs:** `ARCHITECTURE_DECISIONS.md`, `BACKUP_AND_RECOVERY.md`, `RELEASE_REAUDIT.md`, `RELEASE_ASSESSMENT.md`,
`DATABASE_PROVIDER_COMPARISON.md`, `ABUSE_PROTECTION_PROPOSAL.md`, `VALIDATION_STANDARD.md`,
`GUEST_DATA_RETENTION_PROPOSAL.md`, `DATABASE_ARCHITECTURE.md`, `SYSTEM_ARCHITECTURE.md`, and this file.

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
* **Integrity:** a SHA-256 manifest is written last; restore refuses a checksum mismatch, then verifies row counts.
* **Restore safety:** an empty target database only (restore-then-switch); one transaction with `ON_ERROR_STOP`; a
  version-aware filter for newer `pg_dump` output (CI: `pg_dump` 18.6 → server 16).
* **Credentials:** passed to tools through libpq environment variables, never in argv (R-11, tested with wrappers
  around the real binaries).
* **Off-site:** S3-compatible API; `file://` targets are disabled unless explicitly allowed for tests.
* **Pending your decision (§9):** move from age keys to **AWS KMS envelope encryption** (design in
  `DATABASE_PROVIDER_COMPARISON.md` §5). Not implemented in this PR.

## 6. Migration safety
* **Schema migrations:**
  * all pending files apply in one transaction, so a failure leaves the schema unchanged and a re-run recovers;
  * checksummed and append-only;
  * an advisory lock makes concurrent instance start-ups safe;
  * statement and lock timeouts are migration-specific;
  * non-transactional statements are rejected up front.
* **Data migration (JSON → PostgreSQL):**
  * refuses corrupt sources and verifies owner plus byte-identical content of every record inside the
    transaction;
  * a dry run leaves nothing behind;
  * re-running is idempotent and keeps newer PostgreSQL writes;
  * rollback exports to a new directory (tested);
  * **the JSON source is never modified or deleted.**

## 7. Test results and CI evidence
| Layer | Local (this session) | CI on `6fd474d` |
|---|---|---|
| Typecheck / build | ✅ / ✅ | ✅ |
| JSON backend suite | 122 tests: 120 pass, 0 fail, 2 skipped (live Gemini) | same |
| PostgreSQL suite (every server on PG) | 122: 113 pass, 0 fail, 9 skipped (2 live Gemini + 7 JSON-file-specific, with reasons) | same |
| R-02 / R-11 / R-12 / R-14 suites | ✅ both backends | ✅ |
| Browser E2E (JSON, PostgreSQL) | 1/1, 1/1 | 1/1, 1/1 |
| Load test (PostgreSQL) | 0 × 5xx; AI p95 147 ms | n/a |
| Docker | n/a (no daemon here) | 2 instances on 1 DB (migrations 0001+0002 applied once); diagnostics gated (404); unsafe configs refused; backup image tools |

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

## 10. What a reviewer should check by hand
1. `server/db/pgRepo.ts` `reserveAi` / `settleAi` / `expireAiReservations`: same lock order on every path.
2. `server.ts` `rateLimit`: the outcome rule (commit on success or abort; refund on a complete response without
   model output).
3. `server/db/migrate.ts`: `{ attempts: 1 }`, the non-transactional guard, and the timeout values.
4. `server/db/offsiteBackup.ts` `libpqEnv`, `createBackup`, `restoreBackup`: no URL in argv; empty-target check.
5. `server.ts` `hasDiagnosticsAccess`: constant-time compare; 404 for everyone else.
6. CI workflow: `REQUIRE_PG_TESTS=1`, both backend runs, the docker-job 404 assertion.
