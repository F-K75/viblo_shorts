# Forge Studio — Release Assessment

**Current status:** Phase 2 ("Durable architecture") implemented and at its validation gate · **Date:** 2026-11-01 ·
**Branches:** Phase 1 `claude/keen-feynman-xtbvz2` ([F-K75/viblo_shorts#2](https://github.com/F-K75/viblo_shorts/pull/2), CI green, awaiting review) ·
Phase 2 `claude/keen-feynman-xtbvz2-phase2` (stacked on Phase 1) · Nothing was deployed. No infrastructure was created.

Part P2 records Phase 2. Part A (Phase 1) and Part B (Phase 0 discovery) follow unchanged.

## FORGE STUDIO RELEASE READINESS SCORE: 64/100 (Phase 1: 53 · Phase 0: 40)

## Verdict: **NOT READY FOR RELEASE**

Storage is now transactional, multi-instance safe, and backed up off-site with encryption and a tested
restore. Release is still blocked by:
* FS-003: the real Gemini AI has never been observed.
* Choosing and configuring the managed PostgreSQL provider (HA, PITR, region), which is your decision.
* The Phase 3 product and auth fixes.
* Phase 4 operations work: monitoring, CD, object storage for renders.

---

# Part P2 — Phase 2 results

## P2.1 What changed
| Area | Change | Files |
|---|---|---|
| Storage abstraction | One `Repo` interface; `PostgresRepo` (production) and `JsonRepo` (Phase 1 behaviour, dev default, rollback target). Both pass the **same** contract tests | `server/lib/repo.ts`, `server/lib/jsonRepo.ts`, `server/db/pgRepo.ts`, `tests/repo_contract.test.ts` |
| PostgreSQL | `pg` pool (bounded, connect + statement timeouts, TLS policy). Backend selection; production refuses to start without `DATABASE_URL` unless `STORAGE_BACKEND=json` is explicit. Startup waits for the DB with backoff | `server/db/pool.ts`, `server.ts` |
| Schema + migrations | Normalized schema around ownership (`users` with transactional quota counters, `projects` with the API document in `jsonb`, `subscriptions`, `jobs`, `ai_usage_daily`, `rate_buckets`, `window_counters`, `storage_totals`, `data_migrations`). Indexes follow the actual queries. Append-only, checksummed migrations applied once under an advisory lock | `server/db/migrations/0001_initial.sql`, `server/db/migrate.ts` |
| Transactions + isolation | Project writes: one transaction with a per-user row lock; ownership re-checked inside it (`ProjectOwnershipError` → 404); fixed lock order (no deadlocks) | `server/db/pgRepo.ts` |
| Shared limits | Rate-limit buckets (DB clock), guest-mint budget and AI quota (atomic reserve/refund) are shared by every instance and survive restarts | `server/db/pgRepo.ts`, `server.ts` |
| Job queue | `FOR UPDATE SKIP LOCKED` claims, worker heartbeats, cancellation observed from any instance, reaper for dead workers, admission (5 active jobs + render minutes) atomic with the insert | `server.ts`, `server/db/pgRepo.ts` |
| Data migration | `npm run data-migration -- plan \| migrate \| export <dir>`: idempotent, dry-runnable, verified in-transaction (owner + byte-identical content), refuses corrupt sources, never touches the JSON source; rollback export into a new directory | `server/db/dataMigration.ts`, `scripts/data-migration.ts` |
| Encrypted off-site backups | `pg_dump \| age` (public key only; plaintext never on disk) → S3-compatible bucket with a SHA-256 manifest and row counts; verify; restore into an empty DB only, with row-count verification; prune. Backup image with `pg_dump` 17 + `age` | `server/db/offsiteBackup.ts`, `scripts/db-backup.ts`, `Dockerfile.backup` |
| CI | PostgreSQL 16 service; `REQUIRE_PG_TESTS=1` (a PostgreSQL test can never silently skip); full suite on JSON **and** on PostgreSQL; E2E on both; Docker smoke with **two app containers on one database**, plus the JSON container, unsafe-config refusals and the backup image's tools | `.github/workflows/ci.yml` |
| Docs | 8 ADRs; backup/recovery runbook with RPO/RTO and JSON→PostgreSQL cut-over and rollback; guest retention **proposal** | `docs/ARCHITECTURE_DECISIONS.md`, `docs/BACKUP_AND_RECOVERY.md`, `docs/GUEST_DATA_RETENTION_PROPOSAL.md` |

**API contract:** unchanged. The whole pre-existing integration suite and the browser E2E pass unmodified on
PostgreSQL. **Behaviour changes:**
1. Production requires `DATABASE_URL`, or `STORAGE_BACKEND=json` explicitly.
2. Queued render jobs now survive a restart and run afterwards; Phase 1 failed them on boot.
3. A project containing U+0000 is rejected with 400 on PostgreSQL, because `jsonb` cannot store it.
4. Internal job `workerId` is never exposed in responses.

## P2.2 Validation gate evidence (all executed in this session on real PostgreSQL 16.15)
| # | Gate requirement | Evidence | Result |
|---|---|---|---|
| 1 | Migration of existing user **and guest** projects | `tests/phase2.test.ts` › Gate 1-3: a JSON store produced through the real API (2 signed-in users + 1 guest, unicode content) → `plan` (dry run: verification ok, **0 rows left behind**) → `migrate` (6 inserted, snapshot taken) → served from PostgreSQL: every user, including the guest with the same token, sees exactly their projects, content byte-identical | ✅ |
| 2 | No missing or wrongly owned records | In-transaction verification reports `missing=0`, `wrongOwner=0`; per-owner counts 3/1/2; quota counters equal the real row sums. A corrupt source shard aborts with **0 rows written** | ✅ |
| 3 | Rollback tested | After go-live writes in PostgreSQL: re-running `migrate` is idempotent (0 inserted, 6 present; the PG-side edit is reported as `diverged` and **kept**). `export` → new dir → the JSON backend serves the migrated **and** the post-go-live projects. Export refuses a non-empty directory | ✅ |
| 4 | Concurrent writes | Contract test: 20 parallel saves vs a cap of 5 ⇒ exactly 5, counters exact. Two instances: 20 concurrent saves ⇒ 20 rows, `project_count`=20; 10 concurrent updates of one project from both instances ⇒ 1 row, last writer wins. 12 concurrent job creates across instances vs a cap of 5 ⇒ exactly 5 | ✅ |
| 5 | Data isolation between users | Cross-instance read, delete and overwrite by another user ⇒ 404, owner unchanged in the DB; isolation re-checked after migration | ✅ |
| 6 | Rate limits shared across instances | 40 requests alternating between instances ⇒ **exactly 30** (the per-user limit) succeed; global guest-mint budget 4 ⇒ `200×4, 429×2` across instances | ✅ |
| 7 | AI quota survives restarts and multiple instances | 10 concurrent AI calls over 2 instances vs quota 3 ⇒ exactly 3 real results, 7×429, **stub model called exactly 3 times**; both instances restarted ⇒ usage still 3, further calls 429 on both | ✅ |
| 8 | Backup restoration against a real database | `pg_dump \| age` → S3 API (stub) → the object contains **no plaintext** (marker absent; `age-encryption.org/v1` header); a backup without recipients is refused; restore refused into a non-empty DB and without the private key; restore into a new DB verified row counts (3 projects); **the application served the restored data and accepted new writes**; a tampered object fails `verify` (checksum mismatch) | ✅ |
| 9 | Database failure and recovery | TCP-proxy outage: writes ⇒ `503 database_unavailable` in < 5 s (no hang, no crash), `/api/ready` 503, `/api/health` 200; after recovery readiness returns **without a restart**, no data lost, no half-applied write, no unhandled errors. A DB that never comes up ⇒ clear startup failure after the configured retries | ✅ |
| 10 | Existing API and browser E2E tests pass | Full suite on JSON: **108 tests, 106 pass, 0 fail, 2 skipped** (live Gemini; no key). Full suite with **every server on PostgreSQL: 108 tests, 99 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific Phase 1 tests whose PostgreSQL equivalents are gates 1-3/8/9). Browser E2E: 1/1 on JSON, 1/1 on PostgreSQL | ✅ |
| 11 | Production build, typecheck and CI | `npm run lint` 0, `npm run build` 0 locally. **CI: pending.** It runs on the Phase 2 PR, and I will not report it green before it is | ⏳ |

Things that broke during development and how they were fixed:
* The E2E failed under the new "production requires a database" guard. Fixed by having the test declare its backend; the guard was not weakened.
* Multi-instance tests got 401s because each test server generated its own signing key. Fixed in the test harness (one key per test process, like production's shared Google certificates).
* A test deadlocked because `spawnSync` blocked the in-process S3 stub. Fixed with an async CLI helper.
* The test harness silently returned servers that never became healthy. It now fails loudly.

## P2.3 Issue status after Phase 2
| ID | Status |
|---|---|
| FS-001 storage DoS | **Resolved** (per-user transactional quotas on PostgreSQL; JSON interim fix retained) |
| FS-002 data loss / no backups | **Resolved in code**: transactional storage, encrypted off-site backups, tested restore. **Open ops items:** choose the provider, enable HA + PITR, create the bucket with object lock, schedule the backup job, run a restore drill on production-sized data |
| FS-007 quota | **Resolved** (shared, persistent, atomic) |
| FS-008 proxy / limits | **Resolved** (shared buckets) |
| FS-018 O(total) reads | **Resolved** on PostgreSQL (indexed per-user queries) |
| FS-034 guest retention | **Proposal written** (`docs/GUEST_DATA_RETENTION_PROPOSAL.md`); nothing is deleted. Awaiting your approval |
| **FS-037 (new, P2)** | Rendered MP4s are stored on the rendering instance's disk; behind a non-sticky LB a download can 404. The UI doesn't use server renders. Fix: object storage (Phase 4) |
| **FS-038 (new, P3)** | `storage_totals('all')` is a write serialization point. Fine now; shard it if it shows in DB metrics |
| **FS-039 (new, P3)** | Rate-limited requests now do a small DB transaction. Watch DB load; Redis is the documented escape hatch (ADR-004) |
| FS-003, FS-004–FS-006, FS-009–FS-014, FS-019–FS-031, FS-033, FS-035, FS-036 | Open (Phases 3–5) |

## P2.4 Score
| Dimension | Weight | P0 | P1 | P2 | Why it moved |
|---|---:|---:|---:|---:|---|
| Core functionality | 20 | 9 | 9 | 9 | No product changes (by design) |
| Security | 20 | 11 | 14 | 15 | Limits hold across instances; DB TLS; encrypted backups with offline key. CSP, identity swap and guest tokens still open |
| Data reliability | 15 | 3 | 8 | 12 | Transactions, exact quotas, encrypted off-site backups, tested restore and rollback. Provider HA/PITR not configured yet |
| Testing | 10 | 6 | 8 | 9 | Contract tests on both backends, multi-instance and outage tests, CI cannot skip PostgreSQL tests. Still no frontend tests, no live AI |
| Infra / deploy / ops | 15 | 5 | 6 | 8 | Backup image, two-instance container smoke in CI. No CD, monitoring or provisioned infrastructure |
| Performance / scale | 10 | 3 | 5 | 8 | Horizontally scalable app tier (except render files, FS-037) |
| Product / legal readiness | 10 | 3 | 3 | 3 | Phase 3 |
| **Total** | **100** | **40** | **53** | **64** | |

## P2.5 Decisions needed from you
1. **Managed PostgreSQL provider and region**: this determines HA, PITR, the real RPO/RTO and cost.
2. **Off-site bucket provider/region** (different from the DB) and who holds the age private key.
3. Approve the RPO/RTO targets and backup schedule in `docs/BACKUP_AND_RECOVERY.md` §2.
4. Guest retention policy (`docs/GUEST_DATA_RETENTION_PROPOSAL.md`).
5. When to retire the JSON source after cut-over. Proposal: 30 days, and only after a verified off-site restore.

---

# Part A — Phase 1 results

## A1. Approved product decisions (recorded; implemented in Phase 3, not Phase 1)
| Decision | Approved direction |
|---|---|
| Payments | Hide paid plans and checkout claims until a real provider, payment verification, webhooks and subscription lifecycle are implemented and tested |
| YouTube workflow | User-uploaded source videos with server-side compositing; keep original audio only where the user has rights; remove claims about extracting original YouTube footage/audio |
| Database | Managed PostgreSQL for production. SQLite is **not** used as a production stop-gap |

## A2. What changed
| Area | Change | Files |
|---|---|---|
| Fail-closed storage (FS-002) | `readJsonFile` throws `StoreUnavailableError` on corruption instead of returning an empty fallback, and keeps one forensic copy per file version (not one per request). Writes are temp + fsync + rename + dir fsync. The error handler maps it to `503 store_unavailable`; `/api/ready` reports `stores` | `server/lib/storage.ts`, `server.ts` |
| Per-user project shards (FS-001, FS-002, FS-018) | `projects/<userId>.json` plus an in-memory id→owner index. A request reads only its own shard, so one user's data volume or corruption no longer affects others. Same API and the same owner/404 semantics | `server/lib/projectStore.ts`, `server.ts` |
| Verified migration | At first boot: verified `pre-migration` snapshot → split by owner → read back and count → marker → legacy file **renamed, not deleted**. A corrupt legacy file is never migrated or touched (project routes 503) | `server/lib/projectStore.ts` |
| Storage limits (FS-001) | Per project 512 KB; guest 10 projects / 5 MB; user 200 / 25 MB; all guests together 512 MB (signed-in users unaffected); global 4 GB; free-disk floor 256 MB. Only growth is blocked: existing data can still be edited and deleted | `projectStore.ts`, `.env.example` |
| Guest abuse (FS-001) | Global guest-mint budget (1000/hour) in addition to 10/min/IP. Default free subscriptions are no longer persisted per guest (`subscriptions.json` grew without bound) | `server.ts` |
| Snapshots + restore | Verified snapshots (SHA-256 manifest, written to a temp dir, re-hashed, then renamed) at boot and every 6 h with retention 28. CLI `npm run backup -- create/list/verify/restore`. Restore refuses unverified snapshots and a running server, takes a `pre-restore` snapshot and moves current files aside. Health reports the last backup | `server/lib/backup.ts`, `scripts/backup.ts` |
| AI quota (FS-007) | Persistent ledger (`usage.json`). Synchronous reserve (check + increment with no `await` between) makes concurrent overrun impossible in-process. A reservation is refunded unless the handler returns real model output, so fallbacks, provider errors and 4xx are free. Aborted requests keep the charge (the model may have run) | `server/lib/usage.ts`, `server.ts` |
| Proxy / rate limits (FS-008) | `TRUST_PROXY` is **required** in production (`none`, hop count or CIDRs); `true` is rejected. Buckets are keyed per user *and* per IP (IP = 4× user limit), so rotating `X-Forwarded-For` no longer resets a user's limit. Untrusted `X-Forwarded-For` is counted in `/api/health` and logged | `server/lib/security.ts`, `server.ts` |
| Crash scenarios (FS-016, FS-017) | All route handlers forward async rejections to the error handler. Render-job bookkeeping can no longer throw unhandled. `unhandledRejection`/`uncaughtException` handlers log (uncaught → clean exit). Publishing pack validates beats (was a 500) | `server.ts` |
| Limit bypasses (FS-015, FS-032) | Job retry goes through the same admission check as create (5-active cap + render minutes). Queued jobs reserve their minutes. Render download is rate limited | `server.ts` |
| Test support | `GEMINI_BASE_URL` (optional endpoint override) lets tests run the real AI code path against a local stub | `server.ts`, `tests/helpers/geminiStub.ts` |
| Ops config | CI smoke test sets `TRUST_PROXY=none`, runs the backup CLI in the container, and asserts that production refuses to start without `TRUST_PROXY`. Image ships the backup CLI. README and `.env.example` updated | `.github/workflows/ci.yml`, `Dockerfile`, `README.md`, `.env.example` |

**Behaviour changes to be aware of:**
1. Production will not start without `TRUST_PROXY`.
2. A client-supplied project id that does not exist gets a fresh server id. The UI already adopts the returned id, and ids were always server-issued.
3. Guests are capped at 10 projects / 5 MB.
4. Readiness returns 503 when a shared store is corrupt.
5. Saves are slower: p50 27.8 → 59.3 ms in the load test. This is most likely the two fsyncs per write; I did not measure it separately.

## A3. Validation gate evidence (all commands executed in this session)
| # | Gate requirement | Evidence | Result |
|---|---|---|---|
| 1 | Guest storage abuse blocked | `tests/phase1.test.ts` › FS-001: guest stopped at 2 MB (409 `storage_quota_exceeded`); guest pool full → 507 `guest_storage_full`; 11th guest project → 409; >1 MB body → 413; >512 KB project → 413; guest mint budget → 429 `guest_capacity` | ✅ |
| 2 | Normal users unaffected by another user's storage | Same 27.7 MB of attacker data, same test: **old code** victim p95 5.9 → **163.6 ms** (test fails); **new code** 4.9 → 3.4 ms (full-suite run: 9.5 → 7.4 ms). Victim sees only own data | ✅ |
| 3 | Corruption cannot cause global data loss | Corrupt user file: **old code** answers 200 with empty data (and the Phase 0 probe showed the next save wiping all users); **new code** 503 for that user only, file byte-for-byte unchanged, other users keep saving, readiness stays up, one forensic copy. Corrupt `jobs.json` → 503 + readiness 503, file untouched. Corrupt legacy file → no migration, untouched | ✅ |
| 4 | Backup restore restores original projects | Integration test: 3 projects → `backup create` → all deleted via API → restore **refused while server running** → server stopped → restore → restart → the original 3 projects are back. Unit tests: tampered snapshot refused; restore moves current data aside; migration snapshot verifies (`backup verify` exit 0) | ✅ |
| 5 | Concurrent quota requests cannot exceed limits | 10 concurrent AI calls against quota 3 (stub model with 400 ms latency so all are in flight): exactly 3 × 200 real results, 7 × 429, **model called exactly 3 times**. Restart → usage still 3, next call 429 | ✅ |
| 6 | Failed AI calls do not consume quota | Stub returns 500: 4 fallbacks, provider really called (≥4), `dailyQuotaUsed` = 0; invalid request (400) free; after recovery 1 real call → used = 1 | ✅ |
| 7 | All existing tests still pass | `npm test`: **84 tests, 82 pass, 0 fail, 2 skipped** (the live-Gemini tests: no key). 3 existing tests were updated deliberately, not weakened: readiness now also asserts `stores: true`; the storage unit test now asserts fail-closed (the old assertion encoded the FS-002 bug); the E2E sets `TRUST_PROXY=none` as production now requires | ✅ |
| 8 | New regression tests pass | `tests/phase1.test.ts` 17/17, `tests/storage_backup.test.ts` 10/10. **Red-before-green:** the same Phase 1 suite run against unmodified `98cdc30` failed 17/17 | ✅ |
| 9 | Production build and typecheck | `npm run lint` exit 0 (now also typechecks `scripts/backup.ts`); `npm run build` exit 0; browser E2E on the production build 1/1 pass | ✅ |

Other runs: `npm run test:load` completed, with no regression on reads (list p50 19.0 ms vs 20.0 ms) and save p50 59.3 ms (see A2). 10 of the 60 saves returned 409 because the 5 load-test guests hit the new 10-project guest cap. `bun audit`: unchanged (3 advisories, see FS-022).
**Not verified here:** the Dockerfile/CI changes. There is no Docker daemon in this sandbox, so they will be proven by the CI `docker` job when the branch is pushed in a PR.

## A4. Issue status after Phase 1
| ID | Status | Notes |
|---|---|---|
| FS-001 | **Mitigated (interim)** | Bounded and isolated per user; durable fix is PostgreSQL (Phase 2). CAPTCHA/App Check for guest mint still recommended (Phase 3) |
| FS-002 | **Mitigated (interim)** | Fail closed + verified snapshots + tested restore. Still open: backups on the same volume, no PITR/off-host copy (Phase 2) |
| FS-007 | **Resolved for single instance** | Persistent ledger with refunds; multi-instance needs Redis/PostgreSQL (Phase 2). Up to ~1 s of usage can be lost on a hard crash (under-count) |
| FS-008 | **Resolved** | Explicit config and per-user buckets. Rate-limit buckets are still in memory (reset on restart; per-minute only) |
| FS-015 | **Resolved** | Tested |
| FS-016 | **Resolved** | Tested for async routes; process handlers added |
| FS-017 | **Resolved** | Tested |
| FS-018 | **Mostly resolved** | Per-request reads bounded by the user's own shard. Admin "all projects" is still O(total) |
| FS-032 | **Resolved** | Rate limited |
| FS-003, FS-004–FS-006, FS-009–FS-014, FS-019–FS-031, FS-033 | **Open** | Unchanged; scheduled for Phases 2–5 |

**New observations from Phase 1 (added to the register):**
* **FS-034 (P2):** guest data has no retention. After a guest token expires (30 days) its shard is unreachable but kept. Growth is bounded by `GUEST_POOL_MAX_MB`, but once that pool is full, new guests cannot save. A retention policy deletes user data, so it needs your approval.
* **FS-035 (P3):** `/api/health` is public and now exposes more operational detail (storage totals, guest-mint count, proxy diagnostics). Restrict detailed health to an internal port or token in Phase 4.
* **FS-036 (P3):** restoring inside Docker needs `--force`, because the server lock was written by another container. This is documented, but an operator must make sure the service is stopped.

## A5. Updated score
| Dimension | Weight | Phase 0 | Phase 1 | Why it moved |
|---|---:|---:|---:|---|
| Core functionality | 20 | 9 | 9 | No product changes (by design) |
| Security | 20 | 11 | 14 | DoS bounded, proxy spoofing and limit bypasses closed; CSP, identity-swap and guest-token issues remain |
| Data reliability | 15 | 3 | 8 | Fail closed, per-user isolation, verified snapshots and restore; still JSON files, same-volume backups |
| Testing | 10 | 6 | 8 | 27 new regression tests with red-before-green proof; still no frontend tests and no live AI |
| Infra / deploy / ops | 15 | 5 | 6 | Backup CLI, safer config; no CD, monitoring or off-host backups |
| Performance / scale | 10 | 3 | 5 | Per-request cost no longer grows with total data; still single instance |
| Product / legal readiness | 10 | 3 | 3 | Phase 3 |
| **Total** | **100** | **40** | **53** | |

## A6. Next phase (awaiting your authorization)
Phase 2: managed PostgreSQL (projects, jobs, subscriptions, `ai_usage`) with migrations; import from the
shards with verified counts and a pre-import snapshot; PITR and off-host backups; persistent rate limits and
quotas (Redis or PostgreSQL); object storage for renders. I will not start it until you approve.

---

# Part B — Phase 0 discovery report (2026-11-01, baseline `98cdc30`, unchanged)

### 0. What was executed (evidence base)

| Check | Command | Result |
|---|---|---|
| Typecheck (frontend + server) | `npm run lint` | exit 0 |
| Unit + integration | `npm test` | **57 tests: 55 pass, 0 fail, 2 skipped** (the skipped ones are the live-LLM tests; no key) |
| Production build | `npm run build` | exit 0; main chunk 451 KB (123 KB gz) |
| Browser E2E (Playwright, prod build) | `npm run test:e2e` | 1/1 pass (41 s) |
| Dependency audit | `bun audit` | 3 advisories: 1 high (`@grpc/grpc-js`, transitive via firebase/firestore), 1 moderate (`vite` 6.4.4), 1 low |
| CI history (GitHub) | Actions API | 3 runs, all green. **The `live-llm` job on `main` finished in ~1 s, so it skipped and still reports "success"** ([run 41296627233](https://github.com/F-K75/viblo_shorts/actions/runs/41296627233)) |
| Abuse/robustness probes | ad-hoc scripts in `/tmp` against an isolated test server (temp `DATA_DIR`, no secrets) | See FS-001, FS-002, FS-007, FS-017 |

**Not verifiable in this sandbox:** real Gemini output, YouTube oEmbed/caption scraping, Pexels, Firebase sign-in, Google Drive OAuth, remote media (Mixkit/Unsplash) CORS, and `docker compose` hardening. These are marked 🔒 below. They are **not** counted as working.

---

### 1. Executive summary

Forge Studio is an **AI YouTube Shorts studio**. A user enters an idea, or a YouTube link plus transcript. The app produces a scripted, captioned 9:16 Short with kinetic captions, B-roll, optional TTS and music, and the browser exports it. The product is not a code-generation or agent platform. It has no workspaces, teams, WebSockets or agent orchestration.

The previous hardening pass fixed the worst problems: client-trusted identity, path traversal, free plan upgrades, fabricated AI output, broken save and broken export. Those fixes hold up under re-test. The build is reproducible, and the tests are real and pass.

**Release is still blocked.** These are the highest-risk blockers:

1. **FS-001: trivial storage-amplification DoS (verified).** Anyone can mint unlimited guest sessions. Each guest can store 200 × 512 KB of projects in one JSON file, and that file is parsed synchronously on every request. One guest grew the store to 30 MB in 13 s, and an *unrelated* user's request latency went from ~10 ms to ~140 ms. At this rate one IP can push the 1 GB container into OOM within minutes.
2. **FS-002: whole-store data loss on corruption, and no backups (verified).** If `projects.json` ever fails to parse, the next save by *any* user replaces every user's projects with that single project. A forensic copy is kept, but recovery is manual. There is no database, no backup job and no restore procedure.
3. **FS-003: the core AI has never been observed working.** No environment, CI run included, has called Gemini. The configured model ids are unverified, and the CI live-LLM job reports green while skipping.
4. **FS-005 / FS-006: identity and data-loss bugs in auth.** Connecting Google Drive silently switches the signed-in app identity. Signing up, signing in or signing out as a guest orphans all guest projects without warning.
5. **FS-004: "Forgot password" is fake.** It tells the user a reset email was sent, but nothing is sent.
6. **FS-009 / FS-010 / FS-014: product and legal gaps.** Paid plans are advertised ("Encrypted cloud checkout") but no payment provider exists. The headline promise ("clips with original voice and audio") cannot be delivered for YouTube sources. There is no privacy policy or ToS, and captions are fetched by scraping YouTube.

**Issue count:** P0: 3 · P1: 11 · P2: 13 · P3: 6 (33 total).

---

### 2. Architecture overview (verified from code)

```
Browser SPA (React 19 + Vite 6 + Tailwind 4; no router, all state in App.tsx)
 ├─ Firebase Auth JS SDK (email/password, Google popup)   ← firebase-applet-config.json (public web config)
 ├─ Google Drive REST (client-side OAuth token, drive.file scope)
 ├─ Canvas + MediaRecorder export, Web Audio mixing, Web Speech (dictation / browser TTS fallback)
 └─ apiFetch(): Authorization: Bearer <Firebase ID token | guest HMAC token in localStorage>
        │
        ▼
Express 4 (server.ts, 2,360 lines, run by tsx in production)
 ├─ middleware: security headers (no CSP) → request log (JSON) → CORS → json(1 MB) → auth gate
 ├─ per-route token-bucket limiter keyed by client IP (in-memory) + daily AI counters (in-memory)
 ├─ server/lib: auth.ts (RS256 Firebase verify, HMAC guest), security.ts, youtube.ts, llm.ts, storage.ts
 ├─ Gemini (@google/genai): JSON-schema text generation with model failover; TTS
 ├─ YouTube: oEmbed + InnerTube/HTML scraping for captions; Pexels search
 ├─ ffmpeg child processes (caption-only render; queue, cap, kill)
 └─ DATA_DIR: projects.json, jobs.json, subscriptions.json (whole-file sync read/write), renders/*.mp4
```

* **Persistence:** JSON files only. No schema, migrations, indexes or transactions. Every request reads and parses the whole file synchronously (`readJsonFile` uses `fs.readFileSync` + `JSON.parse`).
* **Background jobs:** in-process queue (`renderQueue`, `runningRenders`) with concurrency `MAX_CONCURRENT_RENDERS`. Jobs interrupted by a restart are marked failed on boot. **The frontend never calls the jobs or render endpoints.** They are API-only.
* **Streaming / WebSockets:** none.
* **AI integrations:** five Gemini text endpoints (`generate-script`, `rewrite-beat`, `suggest-hooks`, `optimize-metadata`, `youtube/generate-clips`) and one TTS endpoint. Each text endpoint has a labelled template fallback. No tools or agents. Model output is validated (`validateScript`, sanitizers). Prompts wrap user text in tags.
* **AuthN:** Firebase ID tokens verified server-side (signature, aud, iss, exp, iat). Guest tokens use HMAC-SHA256, last 30 days and cannot be revoked. **AuthZ:** owner checks on projects and jobs; admins via `ADMIN_USER_IDS`.
* **Deployment:** multi-stage Dockerfile (non-root, tini, healthcheck), compose file (read-only FS, limits, untested). CI runs lint → tests → build → E2E → audit → docker smoke. **No CD, registry, staging, monitoring or backups.**

### Frontend → backend map (from `grep` of `apiFetch`/`fetch`)
Used by the UI: `auth/guest`, `projects` (list/get/save/delete/duplicate), `generate-script`, `gemini/{rewrite-beat,suggest-hooks,optimize-metadata}`, `tts`, `stock-footage`, `youtube/{info,captions,parse-transcript,generate-clips}`, `voice-to-text/{transcribe-clip,align-words}`, `publish/generate-pack`, `user/subscription(/upgrade)`.
**Not used by the UI:** `render/*`, `jobs/*`, `quota`, `auth/me`, `config`.

---

### 3. Feature inventory

Legend: ✅ verified by execution · ⚠️ works with defects/limits · ❌ broken or fake · 🔒 unverifiable here (counts as *not verified*) · — not applicable

| # | Feature | Implemented | Functional | Backend-connected | Persists | Failure handling | Tested | Prod-ready |
|---|---|---|---|---|---|---|---|---|
| 1 | Landing page | ✅ | ✅ | — | — | — | E2E (entry) | ⚠️ (no legal pages) |
| 2 | Email sign-up / sign-in (Firebase) | ✅ | 🔒 | ✅ server verifies token | Firebase | ✅ error mapping | server verify only (test keys) | ❌ no verification, no reset |
| 3 | Google sign-in | ✅ | 🔒 | ✅ | Firebase | ✅ | ❌ | ❌ |
| 4 | Forgot password | UI only | ❌ **fake success message** | ❌ | — | — | ❌ | ❌ (FS-004) |
| 5 | "Remember me" | UI only | ❌ no effect | — | — | — | ❌ | ❌ (FS-025) |
| 6 | Guest session | ✅ | ✅ | ✅ | localStorage token | ✅ 401 re-mint | E2E | ⚠️ unlimited minting (FS-001) |
| 7 | Sign-out | ✅ | ⚠️ orphans guest data | ✅ | — | — | ❌ | ❌ (FS-006) |
| 8 | Idea → AI script | ✅ | 🔒 AI / ✅ fallback | ✅ | via save | ✅ labelled fallback | integration (fallback), E2E | ❌ AI unverified (FS-003) |
| 9 | YouTube link → clip strategies | ✅ | 🔒 network / ✅ fallback | ✅ | via save | ✅ grounding warnings | integration (fallback + pasted transcript) | ❌ (FS-003, FS-010) |
| 10 | Paste transcript → captions | ✅ | ✅ | ✅ | via save | ✅ | unit + integration | ✅ |
| 11 | Voice dictation / caption alignment | ✅ | ⚠️ browser Web Speech (Chrome-only API); server timing is an estimate | ✅ | via save | ✅ 422 when nothing available | integration (server) | ⚠️ |
| 12 | Clip trimmer, framing, volume | ✅ | not independently verified | client-only | via save | — | ❌ no automated test | ⚠️ |
| 13 | Timeline / beat editing / caption styles | ✅ | ✅ (E2E touches step 3) | client-only | via save | — | E2E partial | ⚠️ |
| 14 | Beat rewrite / hook suggestions / metadata optimizer | ✅ | 🔒 AI / ✅ fallback flagged | ✅ | via save | ✅ | integration (fallback) | ❌ AI unverified |
| 15 | Stock footage (Pexels / curated) | ✅ | 🔒 Pexels / ⚠️ curated (5 entries have empty `url`) | ✅ | via save | ✅ timeout → curated | integration (curated) | ⚠️ |
| 16 | TTS narration (Gemini) / browser speech fallback | ✅ | 🔒 / ✅ fallback | ✅ | — | ✅ | ❌ live | ❌ unverified |
| 17 | Background music (synthesised) | ✅ | ✅ (export has audio track) | client-only | — | — | E2E (audio stream present) | ✅ |
| 18 | Save project | ✅ | ✅ | ✅ | ✅ JSON file | ✅ visible errors | E2E + integration | ❌ storage (FS-001/002) |
| 19 | My Projects (list/open/duplicate/delete) | ✅ | ✅ | ✅ | ✅ | ✅ | E2E + integration | ❌ storage |
| 20 | Browser MP4/WebM export | ✅ | ✅ for prompt-mode Shorts | client-only | download | ✅ | E2E (duration + audio via ffprobe) | ⚠️ real-time, foreground-only, remote-media CORS unverified (FS-024, FS-026) |
| 21 | Export of YouTube-sourced clip with original footage/audio | ❌ | ❌ by design (iframe can't be captured) | — | — | disclosed in UI | — | ❌ (FS-010) |
| 22 | Publishing pack (platform copy + SRT/VTT) | ✅ | ⚠️ fixed template copy; 500 on malformed beats | ✅ | — | ⚠️ | integration | ⚠️ (FS-017) |
| 23 | Google Drive export | ✅ | 🔒; uploads **only JSON + SRT, never the video** despite the copy | client-only | Drive | ⚠️ | ❌ | ❌ (FS-005, FS-020) |
| 24 | Plans / billing | UI + stub | ❌ upgrades return 501 (correct) but UI advertises paid checkout | ✅ | subscriptions.json | ✅ | integration | ❌ (FS-009) |
| 25 | Usage quotas | ✅ | ⚠️ in-memory; charged for fallbacks | ✅ | ❌ resets on restart | ✅ 429 | integration (partial) | ❌ (FS-007) |
| 26 | Server ffmpeg render + job queue | ✅ | ✅ (caption-only) | API only, **not used by UI** | renders dir (TTL) | ✅ | integration | ⚠️ (FS-015, FS-016) |
| 27 | Health / readiness | ✅ | ✅ | ✅ | — | ✅ | integration | ✅ |
| 28 | Admin (see/delete all projects) | ✅ via `ADMIN_USER_IDS` | not exercised with real Firebase | ✅ | — | — | ❌ | ⚠️ no admin UI or audit log |

---

### 4. Critical bugs and missing functionality

* **Storage engine can be exhausted or wiped:** see FS-001 and FS-002.
* **Account recovery is missing and the UI misreports it:** FS-004.
* **The identity switches silently when Drive is connected:** FS-005. `signInWithGoogleDrive()` calls `signInWithPopup(auth, …)` on the *same* Firebase `auth` that `apiFetch` uses for API identity (`src/utils/googleDrive.ts:49-58`, `src/utils/api.ts:44-48`). A guest or email user who connects Drive with any Google account is from then on authenticated as that Google account. Their projects disappear from My Projects, and new saves go to the other account.
* **Guest data is lost on account transitions:** FS-006. `clearGuestSession()` runs on sign-up, sign-in, Google sign-in and sign-out (`AuthPage.tsx:97,110,150`; `App.tsx:998`). No guest-to-account migration exists and no warning is shown. The guest's projects are then unreachable forever.
* **No working end-to-end path for the headline YouTube use case:** FS-010.
* **Drive export does not export the video:** FS-020. `videoBlob` is accepted in `DriveExportPayload` but never uploaded.
* **Missing for a public launch:** payments (FS-009), legal pages, account deletion and data export (FS-014), email verification (FS-025).

---

### 5. Security findings

| Area | Status | Notes |
|---|---|---|
| Authentication | ⚠️ | Server-side token verification is correct (RS256, aud, iss, exp, iat, timing-safe HMAC). Gaps: guest tokens are irrevocable for 30 days, minting is unlimited apart from 10/min/IP, no email verification, no App Check |
| Session storage | ⚠️ | Guest bearer token lives in `localStorage`. Without a CSP, any future XSS can steal it (FS-013). No `dangerouslySetInnerHTML`/`eval` sinks were found in `src/` |
| Authorization / tenant isolation | ✅ / ⚠️ | Owner checks on every project and job route, 404 on foreign ids (integration-tested). Weaknesses: the identity swap (FS-005); render downloads are unauthenticated capability URLs (128-bit id, 24 h TTL, no rate limit) |
| Secrets | ✅ | Keys come only from env. `/api/config` exposes booleans only. `.env` and `data/` are gitignored. The committed Firebase web config is a public identifier (lock it down with authorized domains + App Check). No secrets were printed during this audit |
| Input validation | ✅ / ⚠️ | Field allowlist and size caps on projects; strict id formats; drawtext escaping (comma text verified safe). Gap: `publish/generate-pack` has no beat validation (verified 500) |
| Injection (SQL/NoSQL/command) | ✅ | No DB. ffmpeg is spawned with an argument array, no shell |
| SSRF | ✅ | Caption URLs go through an allowlist and a private-range blocklist. Other outbound URLs are fixed hosts |
| Prompt injection | ⚠️ acceptable | User and third-party text (YouTube titles, transcripts) is wrapped in tags. The model has no tools, and output is schema-validated and sanitized. Residual risk: injected content can steer generated scripts and titles, so content moderation is absent |
| LLM key exposure | ✅ | Gemini runs server-side only |
| Rate limiting / abuse | ❌ | Per-IP buckets held in memory. They collapse into a single global bucket behind a proxy when `TRUST_PROXY` is unset (FS-008). Guest minting plus storage caps allow DoS (FS-001) |
| CORS / CSRF | ✅ | Bearer auth with no cookies, so CSRF does not apply. Production CORS is same-origin unless `ALLOWED_ORIGINS` is set. Dev mode reflects any origin (dev only) |
| Security headers | ⚠️ | nosniff, frame-options, referrer and permissions policies, HSTS. **No CSP** (FS-013) |
| WebSockets | — | None |
| File upload | — | No server-side upload endpoint. Users only provide URLs and text |
| Dependencies | ⚠️ | 1 high (grpc-js, unreachable: firestore is not imported, ignored in CI with justification); vite moderate (dev server binds `0.0.0.0`) (FS-022) |
| Sensitive data in logs | ✅ / ⚠️ | Request logs carry no bodies or tokens. Gemini error messages are logged truncated. Firebase verification errors are logged. No PII scrubbing policy, and there is no log pipeline to apply one |

---

### 6. Infrastructure and deployment gaps

* No deployment pipeline, image registry, staging environment, release tagging or documented rollback (FS-012).
* The container runs TypeScript via `tsx` at runtime and ships **devDependencies** (vite, typescript, tailwind) because `node_modules` is copied whole from the build stage. The build stage runs `bunx vite build` and skips the typecheck. Base images use floating tags, not digests (FS-021).
* `docker-compose.yml` (read-only root FS, tmpfs, limits) has never been run. Whether `tsx` can run on a read-only FS with only `/tmp` writable is unverified.
* Single instance only. Storage, rate limits, quotas and the render queue live in one process. Horizontal scaling would corrupt data (two writers to the same JSON file).
* No backups or restore drill (FS-002). The renders volume is bounded by TTL.
* No observability backend, alerting, uptime checks, error tracking or frontend error reporting (FS-011).
* No process-level `unhandledRejection` / `uncaughtException` handling (FS-016).

---

### 7. Testing gaps

* **No real-provider coverage:** Gemini, YouTube, Pexels, Firebase and Drive are never exercised. The CI live job turns green when skipped (FS-003, FS-023).
* **Frontend:** no component or unit tests. A single happy-path E2E covers guest → prompt → save → My Projects → export. Not covered: YouTube flow UI, trimmer, caption style editor, TTS, Drive, billing modal, mobile viewport, Firefox/Safari.
* **Untested abuse and failure modes:** storage growth/DoS (FS-001), corruption recovery across users (FS-002), retry quota bypass (FS-015), disk-full, proxy deployments (FS-008).
* No coverage measurement, no load test in CI, no contract tests between `src/types.ts` and server payloads.
* `scripts/loadtest.ts` exists but runs against a tiny dataset, which hides FS-001.

---

### 8. Performance and scalability

* **O(total data) per request:** every project read or write and every AI call (via `getUserSubscription`) does a sync read + parse of a whole JSON file, and writes re-serialize it with indentation. Measured: 30 MB store → ~140 ms blocking per `GET /api/projects` for an unrelated user. This grows linearly, and memory use is several times the file size.
* **LLM latency ceiling:** up to `models × 2 attempts × 25 s` plus backoff, about 100 s for one request with no overall deadline. The client has no cancel. Token counts are aggregated in memory only, with no per-user, per-endpoint or cost ($) tracking and no persistence (FS-011, FS-019).
* **Client export:** real-time (≈1× duration), and the tab must stay in the foreground. The previous audit measured 18.6 fps at 1080p in a headless sandbox. Remote B-roll CORS is unverified (FS-024).
* **Bundle:** 451 KB main chunk. Landing and studio are not split.
* **Render queue:** in-memory, max 2 concurrent ffmpeg processes, 120 s kill. Fine for the caption-only render, but nothing uses it.

---

### 9. Issue register

Severity: **P0** = must fix before any public exposure · **P1** = must fix before GA · **P2** = fix soon after / before scale · **P3** = hygiene.

### P0

**FS-001: Storage-amplification denial of service** · `server.ts` (`POST /api/auth/guest`, `POST /api/projects`, `getStoredProjects`), `server/lib/storage.ts`
* *Problem:* Guest tokens are free (10/min/IP). Each user may store 200 projects × 512 KB = 100 MB, all in one `projects.json` that is parsed synchronously on every request. **Verified:** 60 writes by one guest in 13 s gave a 30.7 MB file and raised another user's `GET /api/projects` to 114–148 ms.
* *Business impact:* any anonymous visitor can take the service down and fill the disk, causing an outage for all users.
* *Technical impact:* event-loop blocking, memory blow-up (OOM at the 1 GB compose limit), disk exhaustion that also breaks renders and readiness.
* *Fix:* short term, cap per-user storage bytes (e.g. 10 MB total, 1–2 MB/project), lower the guest project cap (e.g. 10), add a global guest-mint budget and CAPTCHA/App Check, and stop storing unbounded free-text fields (`topic`, `script`). Proper fix: move to a real database (see FS-002).
* *Validation:* add a load test that replays the probe at 10× scale; p95 for an unrelated user stays < 50 ms; per-user quota returns 413/409; the mint budget enforces 429.

**FS-002: Single-file JSON store: whole-store loss on corruption, no backups, no transactions** · `server/lib/storage.ts:readJsonFile`, all `getStored*` callers
* *Problem:* on a parse failure `readJsonFile` returns the fallback `[]`, and the next write persists only the new record. **Verified:** with 3 stored projects, a corrupted file plus one save by another user left 1 project in the live file. The original data survives only in a `.corrupt-<ts>` copy. No backups, PITR, migrations or restore runbook exist. Single-writer only.
* *Business impact:* permanent loss of all customer projects from one bad write, disk event or manual edit.
* *Technical impact:* no durability guarantees; cannot scale past one process.
* *Fix:* migrate projects, jobs and subscriptions to managed Postgres (or SQLite-WAL as an interim single-node step) with per-row writes, a migrations tool, daily backups plus PITR, and a tested restore. Until then: fail closed (refuse writes, return 503) when a store fails to parse, instead of falling back to empty.
* *Validation:* a corruption test confirms writes are refused and data stays intact; a restore drill from backup is documented and timed; there are integration tests against the DB.

**FS-003: Core AI functionality never verified; CI reports green when skipped** · `server.ts` (`LLM_MODELS`, `TTS_MODEL`), `.github/workflows/ci.yml` (`live-llm`), `tests/llm.live.test.ts`
* *Problem:* no run has ever called Gemini. Model ids `gemini-3.1-flash-lite`, `gemini-3.8-flash` and `gemini-3.8-flash-lite-tts` are unverified. The `live-llm` job ran in ~1 s on `main` and passed. Output quality, latency, cost and the TTS PCM handling are unknown.
* *Business impact:* the product's main value may not work at launch; users would only ever see templates.
* *Technical impact:* unknown failure modes, schema adherence and cost.
* *Fix:* configure a `GEMINI_API_KEY` secret. Make `live-llm` **fail** (not skip) on release branches when the key is missing. Add a golden-set evaluation (≥20 prompts and ≥5 transcripts) checking schema validity, verbatim-caption rate, latency p95 and tokens per call.
* *Validation:* the live suite passes with a real key in CI; the eval report is attached to the release; `/api/health` shows `successes > 0`, `fallbacksServed ≈ 0` on staging.

### P1

**FS-004: "Forgot password" displays a fake success message** · `src/components/AuthPage.tsx:325-335`
* *Problem:* the button calls `setInfoMessage('Password reset email instructions sent…')` and never calls `sendPasswordResetEmail`.
* *Impact:* locked-out users are told an email is on its way; support load, churn and loss of trust.
* *Fix:* call `sendPasswordResetEmail(auth, email)`, handle errors, and use a neutral message ("If an account exists…").
* *Validation:* a test with a Firebase Auth emulator or mocked SDK; manual check against the real project.

**FS-005: Google Drive sign-in silently replaces the app identity** · `src/utils/googleDrive.ts:49-58`, `src/utils/api.ts:44-48`
* *Problem:* the Drive OAuth uses `signInWithPopup` on the shared Firebase `auth`, so it becomes the API identity.
* *Impact:* user projects "vanish", saves land in another account, and two people's data can mix on shared machines.
* *Fix:* obtain the Drive token with Google Identity Services token client (separate from Firebase), or `linkWithPopup`/`reauthenticateWithPopup` for the same user. Never change `auth.currentUser` from the Drive flow.
* *Validation:* E2E with mocked OAuth: user id before and after a Drive connect is identical.

**FS-006: Guest work orphaned on sign-up, sign-in or sign-out** · `AuthPage.tsx:97,110,150`, `App.tsx:990-1000`, `server.ts` (projects)
* *Problem:* the guest token is discarded and nothing migrates the guest's projects.
* *Impact:* the most common conversion path (try as guest → sign up) loses the user's work.
* *Fix:* add `POST /api/auth/claim-guest` (requires both the guest token and the Firebase token) to reassign `userId`. Warn before a guest signs out.
* *Validation:* integration test: guest creates a project → signs up → the project is listed under the Firebase uid.

**FS-007: AI quota accounting is wrong** · `server.ts:201-233` (`rateLimit` with `ai`), `dailyAiCounters`
* *Problem:* the quota is consumed before the call, including when a template fallback is served. **Verified:** `X-Daily-Quota-Remaining: 49` after a fallback response. Counters are in memory, so they reset on every restart or deploy and are not shared across instances. `dailyQuotaUsed` is never persisted.
* *Impact:* users are charged for failures; quotas don't hold, so cost exposure is unbounded across restarts.
* *Fix:* decrement only on a successful model call (or refund on fallback). Persist counters in the DB or Redis.
* *Validation:* tests for fallback (no charge) and restart (counters preserved).

**FS-008: Rate limiting collapses or becomes spoofable depending on proxy configuration** · `server.ts:97-102,182`
* *Problem:* behind a load balancer without `TRUST_PROXY`, all clients share one IP. The whole site then gets 10 guest sign-ups/min and 600 AI calls/day *in total*. With `TRUST_PROXY=true`, `X-Forwarded-For` is spoofable.
* *Impact:* an instant self-inflicted outage at launch traffic, or a bypassed limit.
* *Fix:* require an explicit hop count in production, log a startup warning when a proxy header is seen without `TRUST_PROXY`, and add per-user (not just per-IP) buckets.
* *Validation:* integration tests for both configurations; a staging test behind the real LB.

**FS-009: Paid plans advertised with no payment system; render-minute limits don't apply to real exports** · `src/components/BillingModal.tsx` ($29/$79, "Encrypted cloud checkout"), `server.ts:807-823`
* *Problem:* the UI sells plans the server can't sell (upgrade returns 501). Render minutes are only counted on `/api/render` and `/api/jobs`, which the UI never calls.
* *Impact:* misleading advertising, consumer-protection exposure, no revenue.
* *Fix:* decide on payments: either integrate a provider (Stripe Checkout + webhooks + persisted entitlements) or hide paid tiers behind a "coming soon"/waitlist. Remove unverifiable claims. Define what a "render minute" measures for client exports.
* *Validation:* product sign-off; the copy matches behaviour; webhook integration tests if payments are added.

**FS-010: Headline YouTube flow cannot produce the promised output** · `index.html` / `metadata.json` description, `ShortsPlayer.tsx` export, YouTube caption scraping `server.ts:1727-1816`
* *Problem:* the description promises "clips with original voice and audio". YouTube-sourced exports can't include source footage or audio (iframe capture is impossible; downloading conflicts with YouTube ToS). Captions are scraped via InnerTube/HTML, which is fragile and ToS-sensitive.
* *Impact:* the core use case falls short of what's marketed; legal/platform risk.
* *Fix (product decision):* support creator-uploaded source files (server-side ffmpeg compositing), or reposition the copy to "captions and script from YouTube; export with stock B-roll/TTS". Use the official YouTube Data API captions (owner OAuth) or pasted transcripts only.
* *Validation:* marketing copy reviewed against an E2E of the chosen flow; legal sign-off.

**FS-011: No observability, alerting or LLM cost tracking** · `server.ts` (console logging, `llmMetrics` in memory)
* *Problem:* logs go to stdout only. No error tracking (server or browser), no alerting on `/api/ready`, error rate or latency, no uptime check. LLM tokens are aggregated in process memory only, with no per-user or per-endpoint cost and no budget alarm. TTS tokens are not counted.
* *Impact:* outages and cost spikes go unnoticed.
* *Fix:* log shipping (e.g. to the cloud provider's logging), Sentry or equivalent for both tiers, metrics (Prometheus/OpenTelemetry), a per-request `llm_usage` record (user, endpoint, model, tokens, est. cost) persisted, a provider-side budget cap, and alerts.
* *Validation:* a synthetic failure triggers an alert; a dashboard shows cost per day per endpoint.

**FS-012: No deployment, rollback or staging process** · `.github/workflows/ci.yml`, `Dockerfile`, `docker-compose.yml`
* *Problem:* CI builds an image but doesn't publish or deploy it. There is no staging environment, release versioning or rollback runbook, and the compose hardening is untested.
* *Impact:* manual, unrepeatable releases; slow recovery.
* *Fix:* push immutable tagged images (git sha) to a registry, deploy to staging automatically, promote to prod manually, and document rollback to the previous tag plus data compatibility rules. Run compose (read-only) in CI.
* *Validation:* a dry-run deploy and rollback on staging, timed.

**FS-013: No Content-Security-Policy while bearer tokens sit in localStorage** · `server.ts:106-113`, `src/utils/api.ts`
* *Problem:* any XSS (now or in a future change) would exfiltrate a 30-day irrevocable guest token or Firebase session.
* *Impact:* account takeover blast radius.
* *Fix:* add a CSP with an explicit allowlist (Firebase, Google APIs, fonts, YouTube embeds, media CDNs), `frame-ancestors 'self'`, and guest token revocation (token version per user).
* *Validation:* the CSP header is present; E2E passes with no CSP violations reported.

**FS-014: Legal and compliance prerequisites missing** · repository-wide
* *Problem:* no privacy policy, terms of service, cookie/analytics notice, account deletion or data export, while the app collects emails and stores user content. Stock-media licensing (Mixkit/Unsplash hot-links) and YouTube ToS are unreviewed.
* *Impact:* GDPR/CCPA exposure; app-store and OAuth verification (the Google Drive scope requires a privacy policy) will be refused.
* *Fix:* add legal pages and `DELETE /api/me` with data purge, then review licensing.
* *Validation:* legal sign-off; an integration test for account deletion.

### P2

| ID | Module | Problem (evidence) | Impact | Fix | Validation |
|---|---|---|---|---|---|
| FS-015 | `server.ts:1380-1391` | `jobs/:id/retry` skips the 5-active-job cap and the render-minute check. The minute check is also racy across queued jobs (usage is added only on completion) | Plan limits bypassable; queue flooding | Apply the same guards as `create`; reserve minutes at enqueue | Integration test: cancel 5 → retry 5 → create returns 429 |
| FS-016 | `server.ts:1185-1223`, process | No `unhandledRejection` handler. `upsertJob` (sync write) throwing in `catch`/`finally` of `executeRenderJob` (e.g. disk full) rejects a `void` promise, and Node 22 then exits | Crash loop on disk-full | Wrap job bookkeeping in try/catch; add process handlers that log and exit cleanly | Fault-injection test with read-only DATA_DIR |
| FS-017 | `server.ts:1396-1469` | `publish/generate-pack` with `beats:[null]` → **500 (verified)**. No cap on beat count or text length; negative or NaN times give malformed SRT | Noisy errors; malformed captions | Validate and clamp beats like `normalizeRenderParams` | Unit tests for null, negative and huge input |
| FS-018 | `server.ts` hot paths | Sync whole-file I/O on every AI call (`getUserSubscription`) and on every job progress update | Latency under load (see FS-001) | Resolved by the DB migration; interim in-memory cache with write-through | Load test p95 |
| FS-019 | `server.ts:303-362`, frontend callers | Worst-case LLM request ≈100 s; no overall deadline; no client abort or cancel | Hung UI; wasted cost | Overall budget (e.g. 30 s), AbortController on the client, a single retry policy | Fault-injection test with a slow provider stub |
| FS-020 | `src/utils/googleDrive.ts`, `GoogleDriveExportModal.tsx` | Copy says "upload short videos"; only JSON + SRT are uploaded (`videoBlob` unused). `prompt: 'consent'` forces consent every time | Misleading feature | Upload the exported MP4 (resumable upload) or fix the copy | E2E with mocked Drive API |
| FS-021 | `Dockerfile` | devDependencies shipped; `tsx` transpiles at runtime; the build stage skips the typecheck; floating base tags | Larger attack surface; slower cold start; non-reproducible builds | `bun install --production` in the runtime stage (or compile the server with `tsc`/esbuild), pin digests, run `npm run build` in the image | Image size and SBOM diff; smoke test |
| FS-022 | `package.json` | `vite` 6.4.4 (GHSA-8g5g-mxqh-grgj, dev server); `@grpc/grpc-js` high via firebase/firestore (unused, ignored in CI) | Dev-time exposure; audit noise | Bump vite; re-evaluate the firebase version; keep the CI audit gate | `bun audit` clean or each advisory justified |
| FS-023 | `tests/` | No frontend tests; one happy-path E2E; no tests for Drive, Firebase, YouTube UI, billing UI or mobile; no coverage numbers | Regressions undetected | Component tests (Vitest + RTL) for auth, editor and modals; E2E for the YouTube path and mobile; coverage gate | Coverage report ≥ agreed threshold |
| FS-024 | `ShortsPlayer.tsx` export, `server.ts` curated list | Remote B-roll is loaded with `crossOrigin='anonymous'`; CDN CORS headers unverified (may silently fall back or taint). 5 curated entries have an empty `url` | Exports without B-roll | Proxy or rehost licensed media; drop empty entries | E2E against the real CDNs in staging |
| FS-025 | `AuthPage.tsx` | No email verification; "Remember me" checkbox does nothing (`setPersistence` never called); no App Check; authorized domains unverified | Fake accounts; misleading UI | Implement or remove each item; enable App Check | Manual and automated auth tests |
| FS-026 | `ShortsPlayer.tsx` | Export is real-time, needs a foreground tab, measured 18.6 fps at 1080p (prior audit) | Slow and fragile on low-end devices | Offer the server-side ffmpeg compositor for final export | Benchmark across devices |
| FS-027 | `server.ts:494-622` fallback templates | Fallback scripts contain unsourced health/factual claims ("Melatonin production immediately increases by 40%", "irreversible brain fog") that users may publish | Misinformation and reputational risk | Neutral, claim-free templates | Content review |

### P3

| ID | Module | Problem | Fix |
|---|---|---|---|
| FS-028 | `src/components/YouTubeToClips.tsx` (457 lines), `render/*`, `jobs/*`, `quota` | Dead or unused code paths widen the attack surface and confuse ownership | Delete, or wire into the UI deliberately |
| FS-029 | `server.ts` (2,360 lines), `App.tsx` (1,264 lines) | Monoliths; no router, so no deep links | Split into Express routers and React routes, incrementally |
| FS-030 | `server.ts:1396-1469` | Publishing-pack copy is fixed template text; confirm the UI doesn't present it as AI-generated | Label it, or use the metadata optimizer |
| FS-031 | `server/lib/auth.ts:getCerts` | Cert fetch failure → every Firebase user gets 401 (no stale-cache fallback); the client doesn't retry for Firebase users | Serve stale certs on fetch failure; retry once with a refreshed ID token |
| FS-032 | `server.ts:1284` | `render/download` has no rate limit (bandwidth abuse with a known id) | Add a limiter |
| FS-033 | Bundle | 451 KB main chunk; landing and studio not split | `React.lazy` for studio and modals |

---

### 10. Recommended roadmap

Each phase ends with a gate. Nothing moves to the next phase until its validation criteria are met.

**Phase 1: Stop-the-bleed (P0 safety, ~1 week)**
1. FS-001 interim caps: per-user byte quota, lower guest project cap, global guest-mint budget, CAPTCHA/App Check on guest mint.
2. FS-002 interim: fail closed on store parse errors; nightly volume snapshot + restore drill.
3. FS-008 proxy config hardening + startup warning. FS-007 refund quota on fallback.
4. FS-017 and FS-015 quick fixes; FS-016 process handlers.
*Gate:* abuse probe re-run shows bounded impact; corruption test shows no data loss; all existing tests still green.

**Phase 2: Durable data (P0, ~1–2 weeks)**
5. Postgres (projects, jobs, subscriptions, ai_usage) with migrations, row-level owner queries and backups/PITR. Redis or DB-backed rate limits and quotas.
6. Object storage for renders (if server rendering is kept).
*Gate:* integration suite runs against the DB; restore drill passes; load test at 10× data meets p95 targets.

**Phase 3: Make the product truthful (P0/P1, ~1–2 weeks, product decisions needed)**
7. FS-003 live Gemini verification + eval set; CI fails on skip for release branches.
8. FS-004, FS-005, FS-006, FS-025 auth fixes (reset, Drive token separation, guest claim, verification).
9. FS-009 billing decision; FS-010 YouTube positioning decision; FS-020 Drive export truthfulness; FS-027 neutral templates.
*Gate:* product sign-off on copy versus behaviour; new E2E for the YouTube flow, guest→account, Drive (mocked).

**Phase 4: Operability (P1, ~1 week)**
10. FS-011 logging/metrics/error tracking/alerts and LLM cost ledger; FS-012 registry + staging + rollback; FS-021 image hardening; FS-013 CSP.
*Gate:* staging deploy and rollback rehearsal; an alert fires on synthetic failure; CSP has zero violations in E2E.

**Phase 5: Compliance and quality (P1/P2)**
11. FS-014 legal pages, account deletion and data export; media licensing review.
12. FS-023 frontend tests and coverage gate; FS-024/FS-026 export robustness; P3 cleanup as capacity allows.
*Gate:* release candidate checklist complete; go/no-go review.

Decisions I need from you before Phase 3: **(a)** payments now, or hide paid tiers? **(b)** YouTube flow: support uploaded source files, or reposition the copy? **(c)** database target (managed Postgres recommended; SQLite-WAL only as a stop-gap)?

---

### Score (Phase 0 baseline)

| Dimension | Weight | Score | Rationale |
|---|---:|---:|---|
| Core functionality | 20 | 9 | Prompt → script → edit → save → export works (E2E). Real AI unverified; YouTube headline flow can't deliver; Drive partial |
| Security | 20 | 11 | AuthN/AuthZ solid and tested; DoS, no CSP, identity swap, irrevocable guest tokens |
| Data reliability | 15 | 3 | JSON store, verified whole-store wipe on corruption, no backups |
| Testing | 10 | 6 | Real, passing backend tests and one strong E2E; no frontend or provider coverage |
| Infra / deploy / ops | 15 | 5 | Good Dockerfile and CI; no CD, monitoring, backups or rollback |
| Performance / scale | 10 | 3 | Single instance; O(data) per request (measured) |
| Product / legal readiness | 10 | 3 | Fake reset, unsold paid tiers, no legal pages |
| **Total** | **100** | **40** | |

### Phase 0 baseline score: 40/100 — NOT READY FOR RELEASE (superseded by the Phase 1 score above)
