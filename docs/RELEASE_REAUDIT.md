# Forge Studio — Independent Re-audit + Corrective Round

## Corrective round (2026-11-01): R-02, R-11, R-12, R-14 fixed in PR #3 — awaiting your review

**Status: FORGE STUDIO RELEASE READINESS SCORE: 55/100 (re-audit: 51) — NOT READY FOR RELEASE.**
Readiness is tracked by milestone, not by the score (see the scorecard below). Nothing was merged or deployed.

### What was fixed (one commit each, branch `claude/keen-feynman-xtbvz2-phase2`)
| ID | Commit | Root cause → fix | Evidence |
|---|---|---|---|
| **R-02** (P1) quota deadlock + lost refunds | `101b073` | Reserve locked `user:`→`ip:`; refund updated both via `key = ANY(…)` (scan order) → lock cycle. **Transaction redesign:** one global lock order (own reservation row → counters ascending by key) on reserve, settle and expiry; an `ai_reservations` ledger (migration 0002) makes reserve idempotent per id (no double charge) and settle a conditional `reserved→committed\|refunded` transition (no double refund); never-settled reservations are refunded by expiry (no permanent charge for failures); `withTx` retries `40P01`/`40001` safely as a backstop (residual → 503, not 500) | **Red first:** a 2-instance HTTP storm (80 concurrent fallbacks behind one IP) gave 500s and 503s on the old code. **Green:** 3/3 runs, 0 errors, every reservation refunded; mixed real/fallback storm charges exactly the 30 model calls; 200-cycle repo storm with exact counters; a real `40P01` produced and retried (asserted non-vacuously); idempotency + expiry contract tests on both backends. Original reproduction 45/45 × 200 (was 3 deadlocks). Load test: `generate-script` 15 × 200, p95 147 ms (was 2 × 500, p95 5,074 ms) |
| **R-11** (P2) DB password in argv | `7489fad` | `pg_dump`/`psql` got `--dbname <URL>`. Connection now passed as libpq env (`PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGSSL*`), URL percent-decoded, unknown params rejected | Wrappers around the real binaries record every argv during a full encrypted backup + restore with a password-bearing URL: no password or URL in any argv; password delivered via env; restore verified. *Red evidence is the old source (`'--dbname', url`); the new test cannot run against the old module (new export)* |
| **R-12** (P2) health disclosure + DB-per-request + unthrottled | `3be15b1` | `/api/health` + `/api/live` = liveness `{"status":"ok"}` (no deps); `/api/ready` cached with a single in-flight check; `/api/health/details` behind `HEALTH_DETAILS_TOKEN` (≥ 32 chars, constant-time) or an admin, 404 otherwise; `/api/config` feature flags only; in-memory per-IP throttling (no DB load) | Probe re-run: health flood **1,387/2,000 throttled** (was 0); public disclosure **`{}`** (was hostname, pool, guest counter, memory); a 300-request ready flood → ≤ 2 real checks; details 404 without/with a wrong token and for a normal user. CI asserts details are not public |
| **R-14** (P3) migrations under the request timeout | `10c4485` | Migration-specific `statement_timeout` (30 min) + client query timeout; bounded advisory-lock wait; `lock_timeout` (60 s) for DDL; all pending migrations in one never-retried transaction; non-transactional statements rejected up front | **Red 0/4 → green 4/4:** 3 s migration under a 500 ms request pool succeeds; a timeout leaves the schema unchanged and a re-run recovers; a busy table fails fast on lock timeout with nothing left behind; `CONCURRENTLY` rejected before anything is applied |

### Validation gate (executed this session; standard: docs/VALIDATION_STANDARD.md)
| Layer | Result |
|---|---|
| Typecheck / build | ✅ / ✅ |
| Unit + integration, JSON backend (`REQUIRE_PG_TESTS=1`) | **122 tests: 120 pass, 0 fail, 2 skipped** (live Gemini; no key) |
| Same suite, every server on PostgreSQL | **122 tests: 113 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific, each with a stated reason) |
| Concurrency (new `tests/concurrency.test.ts` + repo storms) | ✅ 3 consecutive green runs |
| Failure injection (DB outage, mid-transaction loss, migration timeout / lock timeout, crash-before-settle via expiry) | ✅ |
| Security / abuse probes re-run | R-12 fixed; **R-03 and R-04 still reproduce** (out of this round's scope; proposal written) |
| Browser E2E (JSON, PostgreSQL) | 1/1, 1/1 |
| Load test (PostgreSQL) | 0 × 5xx; p95: health 31 ms, save 235 ms, list 203 ms, generate-script 147 ms |
| Regression of every earlier finding | ✅ covered by the suites above |
| CI on the PR head | ⏳ **pending this push** (will be reported only after the logs are read) |
| `bun audit` | unchanged: 3 known advisories (FS-022) |

### Still open — explicitly tracked release blockers
| Blocker | Status |
|---|---|
| **Real Gemini generation never demonstrated** (non-negotiable: real API call → render → preview → export) | ❌ open: needs a `GEMINI_API_KEY` |
| R-03 guest sign-up / guest pool DoS | ❌ open: `docs/ABUSE_PROTECTION_PROPOSAL.md` awaiting approval |
| R-04 render queue flooding | ❌ open: same proposal |
| R-13 upload memory pressure (and 1–6 unexplained dropped sockets) | ❌ open: same proposal |
| Fake password reset (R-05) | ❌ open: Phase 3 |
| Google Drive identity switching (R-06) | ❌ open: Phase 3 |
| Guest project ownership / migration on sign-up (R-07) | ❌ open: Phase 3 |
| Drive "video" export uploads no video (R-18) | ❌ open: Phase 3 |
| Payments unimplemented while paid plans are advertised (R-08) | ❌ open: decided "hide paid plans"; Phase 3 |
| Privacy policy, terms, account deletion (R-09) | ❌ open: Phase 4 |
| Production monitoring, alerting, deployment pipeline (R-10) | ❌ open: Phase 4 |
| Managed DB provider, KMS-encrypted off-site backups, measured RPO 15 min / RTO 4 h | ⏳ proposal: `docs/DATABASE_PROVIDER_COMPARISON.md` (needs the hosting-platform decision) |

### Milestone scorecard
| Milestone | Required outcome | Status |
|---|---|---|
| Phase 1 | Storage safety and data integrity | ✅ implemented, CI green, PR #2 awaiting review |
| Phase 2 | Durable PostgreSQL architecture | ✅ implemented + corrective round (this section); **pending your review**; provider not provisioned |
| Phase 2.5 | Abuse protection and concurrency | 🟡 concurrency hardened (R-02); abuse controls proposed, not implemented |
| Phase 3 | Functional AI product and user journeys | ⬜ not started (real Gemini still unverified) |
| Phase 4 | Security, compliance and operations | ⬜ not started |
| Phase 5 | Production deployment and verification | ⬜ not started |

### Process change
`docs/VALIDATION_STANDARD.md` now defines the mandatory gate layers: real DB, a concurrency matrix of every writer
pair, failure injection, free-tier abuse scenarios, red-before-green, non-vacuous assertions, and an independent
re-audit before merging storage/auth/limit changes. The Phase 2 gate missed R-02 because it tested the
scenarios its author imagined rather than every pair of writers to a shared row.

### Score movement (51 → 55)
Data reliability 10 → 11 (quota integrity under concurrency), Security 12 → 13 (credentials out of argv,
diagnostics gated), Testing 7 → 8 (concurrency matrix and failure injection), Performance 6 → 7 (no deadlocks; AI
p95 5.1 s → 0.15 s under load). Core functionality, Infra/ops and Product/legal are unchanged.

---

# Part R — Independent re-audit (discovery restart, unchanged below)


**Date:** 2026-11-01 · **Code audited:** `13e54e5` (head of `claude/keen-feynman-xtbvz2-phase2`, which contains Phase 1) —
the code that would ship. `main` (`98cdc30`) is the original baseline. **Mode:** discovery only. No code,
configuration, data or infrastructure was changed, and neither PR was modified.

**Method.** Earlier assessments were treated as claims, not evidence. Every result below comes from code I read or
a command I ran in this session against real processes: a local PostgreSQL 16.15, the production build, and
headless Chromium. All probes were scripts in `/tmp` against throwaway servers and databases.

## FORGE STUDIO RELEASE READINESS SCORE: **51/100**

## Verdict: **NOT READY FOR RELEASE**

Why this is lower than the 64 reported at the end of Phase 2: the re-audit found **new defects that the
Phase 2 gate missed**. The worst are a PostgreSQL deadlock that loses quota refunds and returns 500s, and cheap
denial-of-service paths against guest onboarding and the render queue. An earlier claim ("the code cannot
deadlock", ADR-003) is **false**. The previous score over-credited security and data integrity.

---

## 1. Executive summary

**What is genuinely solid (verified this session):**
* Server-verified authentication, owner-only authorization and 404-on-foreign-ids. Abuse limits hold per user,
  per IP and across instances.
* Transactional PostgreSQL storage with exact per-user quotas. A verified, idempotent JSON → PostgreSQL migration
  with dry run and rollback. Encrypted off-site backups whose restore was proven, including across `pg_dump`
  versions in CI.
* Reproducible build, a large real test suite (below), and the prompt → script → save → export journey working in a
  real browser on PostgreSQL.

**Release blockers (highest risk first):**
1. **R-01 (P0, unchanged since discovery):** the core AI has **never been observed working**. Both live tests
   skip; CI's live job only runs on `main`, without a key.
2. **R-02 (P1, NEW):** PostgreSQL **deadlocks** under concurrent AI requests from one network → HTTP 500s and
   **lost quota refunds** (users charged for template fallbacks again). Reproduced: 3/45 requests.
3. **R-03 (P1, NEW, introduced by the Phase 1 fix):** the global guest sign-up budget can be **exhausted in
   ~2 s**, locking every new visitor out of guest mode for an hour. The guest storage pool fills in ~32 s.
4. **R-04 (P1, NEW):** free guests can queue **500 one-minute 1080p renders in 1.5 s**; real users' jobs starve
   and instance CPU stays saturated.
5. **R-05 – R-09 (P1, unchanged since discovery, frontend untouched):** fake "Forgot password", Drive sign-in
   silently switches the account, guest work orphaned on sign-up/sign-in/sign-out, paid plans and "Encrypted cloud
   checkout" advertised with no payment system, no privacy policy/terms/account deletion.
6. **R-10 (P1):** no production infrastructure exists yet: no provider, HA, PITR, bucket, CD, staging,
   monitoring or alerting.

## 2. Evidence base (executed in this session)

| Check | Result |
|---|---|
| `npm run lint` (frontend + server + scripts) / `npm run build` | exit 0 / exit 0 (main chunk 451 KB) |
| `npm test`, JSON backend, `REQUIRE_PG_TESTS=1` | **110 tests: 108 pass, 0 fail, 2 skipped** (live Gemini, no key) |
| `npm test`, every server on PostgreSQL | **110 tests: 101 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific, each with a stated reason) |
| Browser E2E on production build, PostgreSQL | 1/1 pass |
| Load test, PostgreSQL, 20 concurrent clients | health p50 20.7 / p95 43.3 ms; save p50 120 / p95 225 ms; list p50 61 / p95 184 ms; **generate-script: 2 × HTTP 500, p95 5,074 ms** |
| `bun audit` | 3 advisories (1 high via firebase→firestore→grpc-js, not imported; vite moderate; low) |
| CI (GitHub) on `13e54e5` | test + docker green ([run 41320121004](https://github.com/F-K75/viblo_shorts/actions/runs/41320121004)); `live-llm` **skipped** |
| Frontend diff since baseline | **0 changed files** in `src/` and `index.html` |
| Probes (this audit) | deadlock reproduction; guest-mint and guest-pool exhaustion; unauthenticated health flood; health disclosure; render-queue starvation (results in §4) |

**Not verifiable here:** real Gemini, YouTube, Pexels, Firebase sign-in, Google Drive, remote media CORS, a
managed PostgreSQL provider's HA/PITR, real S3 (an S3-API stub was used), or production-sized restore times.
None of these are counted as working.

## 3. Architecture (as built)

React 19 SPA (unchanged since baseline) → Express 4 (`server.ts`, ~2.5k lines, run by `tsx`) → `Repo` interface
with a **PostgreSQL** implementation (production; transactional; rate limits, quotas, render queue and guest
budget shared across instances) and a **JSON** implementation (development and rollback; single instance).
Gemini via `@google/genai` (template fallbacks), YouTube oEmbed plus caption scraping, Pexels, and ffmpeg
renders on the instance's own disk. Off-site backups use `pg_dump | age` → S3-compatible storage
(`Dockerfile.backup`). CI: typecheck, both backends, E2E, audit gate, and a Docker smoke test with two instances
on one database.

## 4. Findings

Severity: **P0** = blocks any public exposure · **P1** = blocks GA · **P2** = fix before scale · **P3** = hygiene.

### NEW in this re-audit

**R-02 · P1 · PostgreSQL deadlock between AI quota reservation and refund** — `server/db/pgRepo.ts`
(`reserveAi`, `refundAi`), `server.ts` (`rateLimit`)
* *Problem:* `reserveAi` locks `ai_usage_daily` rows in order `user:<id>` → `ip:<addr>`. `refundAi` runs one
  `UPDATE … WHERE key = ANY(…)`, which locks the same two rows in scan order (often `ip:` first). Two concurrent
  requests sharing an IP can each hold one row and wait for the other.
* *Evidence:* 15 concurrent `generate-script` calls from 5 guests on one IP, run 3 times → `error: deadlock
  detected` (HTTP 500) in 3/45 requests and `{"event":"ai_refund_failed","error":"deadlock detected"}`. The load
  test reproduced it independently (2 × 500).
* *Business impact:* users behind one NAT, office or mobile carrier see random 500s on AI actions **and are charged
  quota for failed/template calls**. That is the FS-007 guarantee broken again, but only on PostgreSQL.
* *Technical impact:* aborted transactions; the refund is not retried; quota counters drift upward.
* *Fix:* take rows in one deterministic order on both paths: refund with per-key UPDATEs in the same order as
  reserve (or `SELECT … ORDER BY key FOR UPDATE` first). Retry a transaction once on SQLSTATE `40P01`/`40001`;
  map an exhausted retry to 503, not 500.
* *Validation:* a concurrency test with ≥ 50 concurrent fallback AI calls from one IP across 2 instances ⇒ 0 × 500,
  0 `ai_refund_failed`, and `dailyQuotaUsed` = 0 afterwards; the load test shows no 500s.

**R-03 · P1 · Guest onboarding denial of service (global sign-up budget, guest storage pool)** — `server.ts`
(`guestMintBudget`), `server/db/pgRepo.ts` (guest pool)
* *Problem:* the global budget (`GUEST_MINT_PER_HOUR=1000`) is first-come-first-served. The 512 MB guest pool is
  shared by all guests with no expiry (FS-034).
* *Evidence:* 1,000 guests minted from 1,000 IPs in **2,042 ms**; a new visitor then got `429 guest_capacity`.
  From only 2 IPs at the per-IP limit it takes ~50 min. Those guests filled the pool (1,037 × 500 KB) in **32 s**;
  after that only saves smaller than the remaining headroom succeed. Signed-in users were unaffected.
* *Impact:* the "Explore as Guest" funnel, the main conversion path, can be switched off by anyone for an hour at
  a time.
* *Fix:* CAPTCHA/App Check on guest mint; per-/24 (IPv4) and per-/48 (IPv6) budgets instead of one global
  counter; guest retention/expiry (approve the retention proposal) so the pool frees itself; alerting on budget
  exhaustion; optionally keep a reserved share of the budget for traffic that passes the CAPTCHA.
* *Validation:* the same probe cannot block a fresh visitor who passes the CAPTCHA; pool usage drops after
  expiry runs.

**R-04 · P1 · Render queue starvation / CPU exhaustion by free guests** — `server.ts` (`/api/jobs/create`,
worker), `server/db/pgRepo.ts` (`claimNextJob`)
* *Problem:* any guest may queue 5 × 60 s 1080p renders (10 free render-minutes each). Guests are free to mint, and
  the queue is global FIFO with no fairness or priority.
* *Evidence:* 100 guests queued **500 jobs in 1,555 ms**; a signed-in user's 10 s job was still `queued` after
  20 s with both render slots busy.
* *Impact:* server renders unusable for real users, and render CPU steals capacity from web requests on the same
  instance. The UI does not use server renders today, but the endpoint is public.
* *Fix:* disable server rendering for guests (or behind a feature flag until the UI uses it); per-user fair
  queueing (round-robin by user); a global queued-job cap with 503; run renders on separate worker instances
  (Phase 4, with FS-037).
* *Validation:* the probe cannot delay a signed-in user's job by more than one render slot.

**R-11 · P2 · Database credentials on the command line** — `server/db/offsiteBackup.ts` (`pg_dump`, `psql`
spawned with `--dbname <DATABASE_URL>`)
* *Problem:* the full URL, including the password, appears in the process arguments, which are readable via
  `/proc/<pid>/cmdline` / `ps` by other processes on the host or in the container.
* *Fix:* pass host/port/db/user as arguments and the password via `PGPASSWORD` in the child's environment (or a
  0600 `.pgpass`); never include the password in argv.
* *Validation:* while a backup runs, `ps -o args` shows no password.

**R-12 · P2 · Unauthenticated, unthrottled endpoints that hit the database and disclose internals** —
`server.ts` (`/api/health`, `/api/ready`)
* *Evidence:* 2,000 concurrent anonymous `/api/health` calls → 2,000 × 200, 0 throttled, each running a DB query.
  The response exposes hostname:pid, DB pool counts, the guest-mint counter (lets an attacker watch R-03 progress),
  proxy configuration and memory.
* *Fix:* public liveness returns `{status}` only; detailed health behind an internal port or token; rate-limit both
  or cache the DB check for ~1 s.
* *Validation:* an anonymous `/api/health` returns no internals; a flood is throttled or does not reach the DB per
  request.

**R-13 · P2 · Memory pressure from concurrent large request bodies** — `server.ts` (`express.json({limit:'1mb'})`)
* *Evidence:* ~250 concurrent 500 KB uploads → heap ~308 MB used, RSS 443 MB, and 6 of 1,054 uploads saw dropped
  connections (`UND_ERR_SOCKET`). The server stayed up. **The dropped connections were not root-caused.**
* *Impact:* with the 1 GB container limit, a larger burst of ~1 MB bodies could OOM-kill an instance.
* *Fix:* cap concurrent body-parsing requests (or a lower body limit for non-project routes); measure with a
  1,000-concurrent 1 MB test; investigate the socket resets.
* *Validation:* a 1,000 × 1 MB burst leaves the process alive with bounded RSS.

**R-14 · P3 · Migrations run under the 10 s statement timeout** — `server/db/pool.ts`, `server/db/migrate.ts`
* *Problem:* a future migration on a large table (index build, backfill) will be cancelled mid-way at startup.
* *Fix:* `SET LOCAL statement_timeout = 0` (or a migration-specific value) inside the migration transaction; run
  heavy migrations as a release step.

**R-15 · P3 · Latency on PostgreSQL is 2–3× the JSON backend under load** — measured locally on one machine with
DB and app co-located: save p50 120 ms (JSON ~59 ms), list p50 61 ms (JSON ~19 ms) at 20 concurrency.
Acceptable now; re-measure against the real provider (network RTT adds per query) and reduce round-trips per
request (rate limit + quota + write are separate transactions).

### Still open from discovery (re-verified in current code)
| ID | Sev | Issue | Re-verification |
|---|---|---|---|
| R-01 (FS-003) | **P0** | Real Gemini never observed; model ids unverified | live tests skipped; CI `live-llm` skipped on PRs |
| R-05 (FS-004) | P1 | "Forgot password" shows a success message, sends nothing | `AuthPage.tsx:329` |
| R-06 (FS-005) | P1 | Drive OAuth uses `signInWithPopup` on the shared Firebase auth → switches the app identity | `googleDrive.ts:52` |
| R-07 (FS-006) | P1 | Guest work orphaned on sign-up/sign-in/sign-out (no claim/migration) | 4 × `clearGuestSession()` |
| R-08 (FS-009) | P1 | $29/$79 plans + "Encrypted cloud checkout" advertised; no payment provider | `BillingModal.tsx:256,324,375` |
| R-09 (FS-014) | P1 | No privacy policy, terms, account deletion or data export | 0 matches in `src/` |
| R-10 (FS-011/012) | P1 | No CD, staging, monitoring, alerting, LLM cost ledger; no provisioned DB/bucket | — |
| R-16 (FS-010) | P1 | Headline "original voice and audio" from YouTube can't be delivered; captions via scraping (ToS) | approved direction (uploads + server compositing) not started |
| R-17 (FS-013) | P2 | No Content-Security-Policy; 30-day irrevocable guest token in `localStorage` | 0 matches for CSP |
| R-18 (FS-020) | P2 | Drive export claims video upload; only JSON + SRT uploaded | `videoBlob` declared, never used |
| R-19 (FS-025) | P2 | No email verification, no App Check; "Remember me" does nothing | no `setPersistence` |
| R-20 (FS-037) | P2 | Rendered MP4s on the rendering instance's disk (404 behind non-sticky LB) | ADR-007 |
| R-21 (FS-021) | P2 | Runtime image ships devDependencies; `tsx` at runtime; floating base tags | Dockerfile |
| R-22 (FS-022) | P2 | Dependency advisories (see §2) | `bun audit` |
| R-23 (FS-023) | P2 | No frontend unit/component tests; one happy-path E2E; concurrency on AI paths untested (this is how R-02 slipped) | test inventory |
| R-24 (FS-027) | P2 | Fallback templates contain unsourced health claims | `server.ts` templates |
| R-25 (FS-026/024) | P2 | Export real-time, foreground-only; remote media CORS unverified | — |
| R-26 | P3 | Monolithic `server.ts` / `App.tsx`; dead `YouTubeToClips.tsx`; 451 KB main chunk | — |

### Verified fixed (no longer findings)
Client-trusted identity and header-spoofable admin; path traversal; free self-upgrade of plans; foreign
jobs/projects access; storage amplification per user and cross-user latency (victim p95 stays ~7 ms with
27.7 MB of attacker data); whole-store loss on corruption; in-memory quotas lost on restart; proxy-spoofable rate
limits; job-retry limit bypass; async route crashes; crash on DB connection loss; restore across `pg_dump`
versions. All of these are reproduced by tests that ran green in this session.

## 5. Security summary
* **AuthN/AuthZ:** solid and tested (RS256 Firebase verification, HMAC guest tokens, owner checks, 404s).
  Weaknesses: the Drive identity switch (R-06), irrevocable 30-day guest tokens and no CSP (R-17), no email
  verification or App Check (R-19).
* **Abuse/availability:** per-user/IP limits hold, but the *free guest* tier is the soft spot: onboarding DoS
  (R-03), render-queue CPU abuse (R-04), unthrottled DB-touching health endpoints (R-12), memory pressure (R-13).
* **Secrets:** env-only and never logged; but DB credentials go into process argv during backups (R-11).
  Backups are encrypted with an offline private key.
* **Injection:** parameterized SQL throughout (the only interpolations are constant table names and test DB
  names); ffmpeg via argv; SSRF allowlist; prompt input tag-delimited and output schema-validated.

## 6. Testing gaps
The concurrency suite covers saves, reservations and job claims, but **not concurrent AI fallbacks/refunds on one
key**, which is how R-02 shipped through a green gate. Also missing: free-tier abuse tests (R-03/R-04),
frontend component tests, real-provider tests (Gemini, Firebase, Drive, YouTube), and load tests at production
scale against a remote database.

## 7. Performance / scalability
App tier scales horizontally, except render files (R-20). On PostgreSQL each AI request performs 3–4 separate
transactions (rate limit, subscription read, quota reserve, refund), so latency grows with DB round-trip time.
Deadlocks (R-02) appear at modest concurrency. The render CPU shares the web instances (R-04).

## 8. Score
| Dimension | Weight | Score | Rationale |
|---|---:|---:|---|
| Core functionality | 20 | 8 | Prompt → export works (E2E); AI never observed; YouTube headline undeliverable; Drive half-implemented; fake reset |
| Security | 20 | 12 | Strong authN/Z and limits; free-tier DoS paths, Drive identity switch, no CSP, credentials in argv |
| Data reliability | 15 | 10 | Transactions, verified migration, tested encrypted restore; deadlock-driven quota drift; no provider HA/PITR configured |
| Testing | 10 | 7 | Large, real, dual-backend suite; missed the AI concurrency deadlock; no frontend or live-provider tests |
| Infra / deploy / ops | 15 | 6 | Images and CI solid; no CD, staging, monitoring, provisioned DB/bucket |
| Performance / scale | 10 | 6 | Horizontal app tier; deadlocks under concurrency; per-instance renders; body memory pressure |
| Product / legal readiness | 10 | 2 | Fake reset, unpurchasable plans advertised, no legal pages, YouTube ToS exposure |
| **Total** | **100** | **51** | |

## FORGE STUDIO RELEASE READINESS SCORE: 51/100 — **NOT READY FOR RELEASE**

## 9. Recommended roadmap (adjusted by this re-audit)
1. **Phase 2.1 — correctness hotfix (before anything else; small, on the Phase 2 branch):** R-02 deadlock + retry,
   R-11 credentials out of argv, R-14 migration timeout, R-12 health hardening, plus a concurrency regression test
   for AI refunds.
2. **Phase 2.2 — free-tier abuse controls:** R-03 (CAPTCHA/App Check, per-subnet budgets, retention once
   approved) and R-04 (no guest renders, fair queue, global cap), R-13 body concurrency cap.
3. **Phase 3 — product correctness (as planned):** live Gemini validation + eval set (R-01), auth fixes
   (R-05/06/07/19), hide paid plans (R-08), Drive truthfulness (R-18), uploaded-source workflow (R-16), neutral
   templates (R-24).
4. **Phase 4 — operations:** provider + bucket provisioning with HA/PITR, CD + staging + rollback, monitoring and
   alerting (including guest-budget and deadlock alerts), CSP, object storage and separate render workers
   (R-20/R-04), image hardening.
5. **Phase 5 — certification:** legal pages and account deletion (R-09), frontend and live-provider tests,
   production-scale load and restore drills, security retest.

**Decisions needed:** whether to fold Phase 2.1 into PR #3 before review (recommended: it fixes a regression of a
Phase 1 guarantee), plus the five Phase 2 decisions already pending (provider, bucket and key custody, RPO/RTO,
guest retention, merge order).
