# Phase 2.5: Implementation Plan and Execution Checklist

> **Status: plan only. NOTHING here is authorized for implementation yet.** Implementation, deployment and AWS
> provisioning each need your explicit approval. Baseline: `main` @ `be4c48e` (Phase 1 + Phase 2 integrated).
> Design source: `docs/PHASE2_5_PLAN.md` (approved with conditions in its §7). This document turns that design into
> PR-sized steps, gates and checks. Release assessment stays **NOT READY (58/100, provisional)**.

## 0. Ground rules for every step
* **One PR per track** (A–E below), branched from the then-current `main`. Merge only with your explicit approval,
  using a merge commit, after CI is green and the logs are inspected.
* **Red first:** each vulnerability or requirement gets a test that fails on the code before the change. The red
  run is committed (tests-only commit) before the fix, as in the F1–F6 and J1 rounds.
* **No new paid services or recurring costs** without approval. ASN/MaxMind stays deferred.
* **No upload system in this phase** (your decision). Its architecture is written separately (track D3, docs only).
* **All limits configurable** through environment variables, with defaults from `PHASE2_5_PLAN.md` §7, and documented
  in `.env.example`.
* **Migrations:** new files only (`0003_…`, `0004_…`), named `NNNN_lower_snake_case.sql`. The
  `-- forge:backward-compatible` marker only on expand-only files, and **manual review of every backfill**
  (ADR-002).
* **Both backends:** every server-level test runs under `TEST_STORAGE_BACKEND=json` and `=postgres`, or is pinned to
  one backend with a stated reason.
* **Evidence per PR:**
  * the root cause per finding and red→green test output;
  * three consecutive runs of the new tests;
  * the full JSON and PostgreSQL suites, E2E on both backends, and the build;
  * Docker CI, with every job's log inspected;
  * an updated `RELEASE_REAUDIT.md`.

## Track A: Guest registration protection (R-03). PR "phase2.5-a"
| # | Step | Done when |
|---|---|---|
| A0 | **Measure first.** Record hourly guest mints (extend the `guest-mint` window counter to a 30-day hourly series; no new dependency) | Metric visible in `/api/health/details`; the hard ceiling stays **provisional** until 14 days of real data exist |
| A1 | Red tests: guest registration flood; verified-user lockout (an attacker rotating IPs exhausts today's global budget, then a CAPTCHA-verified victim gets 429) | Fail on `be4c48e` |
| A2 | `CaptchaVerifier` interface: `TurnstileVerifier` (server-side `siteverify`, 3 s timeout, hostname + action + token age checks) and `StubVerifier` (tests only, never selectable in production) | Unit tests; production refuses to start without `TURNSTILE_SECRET` unless explicitly disabled |
| A3 | **Single-use tokens:** migration `0003_captcha_redemptions.sql` (unique token hash + TTL), redeemed atomically in the mint transaction; JSON-backend equivalent | Replay across **2 instances** → exactly one success |
| A4 | Hierarchical budgets on the existing PostgreSQL token buckets: device / IP / IPv4 /24 / IPv6 /48 | Each holds exactly at N under 50 concurrent requests across 2 instances |
| A5 | Device cookie `__Host-fs_dev`: first-party, `Secure`, `HttpOnly`, `SameSite=Lax`, opaque 128-bit random value, only its SHA-256 stored, no personal data | Test asserts every attribute and that no identifier derived from IP or user agent is stored |
| A6 | Global **soft** threshold: escalates challenges and raises alerts, never rejects verified humans. **Hard** ceiling from `GUEST_MINT_HARD_PER_HOUR` (provisional default, later 10× measured p99) | Lockout test (A1) green; ceiling configurable and documented |
| A7 | CAPTCHA outage: new guest registrations pause (503 `captcha_unavailable`); existing guest sessions and authenticated users unaffected | Siteverify down (stub server) → `/api/auth/me`, project save and AI calls still succeed |
| A8 | Client: Turnstile widget before the first guest mint; site key from `/api/config` | Browser E2E with Cloudflare's documented test keys [to confirm at implementation time] |
| A9 | Privacy-policy text for the device cookie (purpose: security / strictly necessary) | Draft text in docs, for your approval |

**Needs from you before A goes live (not before implementation):** a Cloudflare Turnstile widget (free tier) and its
secret stored in GitHub Actions or Secrets Manager. I never handle the value.

## Track B: Render queue fairness and exactly-once settlement (R-04, F7). PR "phase2.5-b"
| # | Step | Done when |
|---|---|---|
| B1 | Red tests: guest server render accepted today; starvation (A's backlog delays B); F7 crash between finish and billing leaves the render unbilled | Fail on the code before the change |
| B2 | Guests cannot start server renders (`403 sign_in_required`); guest editing and browser preview unchanged. **No claim that browser export works** until an exported MP4 is verified (track E) | Zero jobs and zero ffmpeg processes for guests; existing guest E2E unchanged |
| B3 | Limits: 1 running and 3 queued per user, global queue 200, all configurable; above capacity `429 queue_full` + `Retry-After` | 2 instances × 300 concurrent admissions → exactly the cap accepted |
| B4 | Fair claim: round-robin across users (`FOR UPDATE SKIP LOCKED` over each user's oldest job); migration `0004_jobs_fair_queue.sql` (index; expand-only) | 3 users × 3 jobs → round-robin order; no starvation |
| B5 | **Exactly-once render-minute settlement:** reservation ledger (`render_reservations`), committed in the **same transaction** as `finishJob`, refunded exactly once on cancel, timeout, failure or reaper action (fixes F7) | Duplicate cancel/finish/reap → one settlement; counters exact |
| B6 | Timeouts: wall clock per job (3 × duration, ≤ 600 s) and queue-wait expiry; zombie-free kill | Hanging stub ffmpeg killed; minutes refunded once |
| B7 | **Crash recovery:** a stale heartbeat requeues a job once (`attempts < 2`), otherwise fails it with one refund | Kill a worker mid-render on 2 instances → completes elsewhere or one refund |
| B8 | No paid-priority wording anywhere (UI, API, docs) | Grep check in tests |

## Track C: Memory protection and backpressure (R-13). PR "phase2.5-c"
| # | Step | Done when |
|---|---|---|
| C1 | Red tests: a 900 KB body to a small-payload route is fully parsed today; 50 concurrent 1 MB bodies grow memory without bound | Fail on the code before the change |
| C2 | Route-specific body limits (projects 512 KB, AI text 32 KB, transcript 256 KB, TTS 8 KB, default 16 KB); checked against `Content-Length` and while streaming | Over-limit → 413 before parsing; chunked bodies too |
| C3 | Large-body concurrency semaphore (`BODY_CONCURRENCY`) → 503 `busy` + `Retry-After` | Excess rejected; process healthy |
| C4 | Memory guard (`MEMORY_SOFT_LIMIT_MB`): 503 for body-heavy and render requests, `/api/ready` not-ready, automatic recovery | Injected RSS reader: drain, then recover |
| C5 | Explicit `headersTimeout` / `requestTimeout` (slow clients) | Slow-loris test closes the connection |

## Track D: Recovery and operations hygiene (docs plus small fixes; can be folded into A–C)
| # | Item | Plan |
|---|---|---|
| D1 | J2: point-in-time consistency of command-line JSON snapshots taken while the server runs | **Needs your decision on the required guarantee.** Options: (a) document "stopped server or scheduled snapshots only" (current); (b) the CLI asks the running server for a snapshot over a local admin channel |
| D2 | Docker-level test of the J1 restore guard (gap noted at the PR #3 merge) | Optional CI step, only if you approve: a journal in the volume → container exits 1, volume unchanged → `recover` → starts |
| D3 | Upload system architecture (no code) | Separate document from `PHASE2_5_PLAN.md` §3.2: pre-signed S3 POST, magic-byte validation, ffprobe, lifecycle cleanup |
| D4 | F8–F11 hardening (owner predicate on project upsert, data-migration counter rebuild, expiry comment, TLS policy for verify connections, `ai_reservations` in verification) | Small red-first fixes, batched |

## Track E: Live Gemini to playable MP4 (R-01, release blocker). Separate PR, separate approval
| # | Step | Done when |
|---|---|---|
| E1 | `.github/workflows/live-ai.yml`: `workflow_dispatch` only, GitHub environment `live-ai` with you as required reviewer, `concurrency: live-ai`, 20-minute timeout, never on forks or pushes | Workflow lint; cannot run without your approval |
| E2 | Secret `GEMINI_API_KEY_LIVE` (restricted key: Generative Language API only, low daily quota) created by you in that environment; masked; never printed | Test asserts the key string appears in no artifact or log |
| E3 | Real flow, no mocks: sign in → create project → `/api/generate-script` returns model output (**fails on fallback**) → assets → server render → MP4 download → `ffprobe` (video stream, duration ±10 %, audio when narrated, non-black frames) → preview plays → UI export byte-equal to the API file | All assertions on the real output |
| E4 | Metrics artifact: per-call latency, token counts, estimated cost (dated pricing table, marked as an estimate), model id, fallback/error counts, render time, MP4 size and duration | JSON artifact attached to the run |
| E5 | Browser export check: the exported file must itself be a playable MP4 (the previous audit found Drive export broken) | Verified file, or the export claim stays withdrawn |

**Needs from you:** the restricted key in the `live-ai` environment, and approval to run the workflow (each run costs
API usage).

## Phase 2.5 gate (all required before asking you to merge each PR)
1. Guest registration flood test.
2. Verified-user lockout prevention test.
3. CAPTCHA replay prevention across 2 instances.
4. Multi-instance rate-limit test.
5. Render starvation regression test.
6. Concurrent queue admission test.
7. Cancellation and exactly-once refund test.
8. Crash recovery test.
9. Memory-pressure test.
10. Full existing regression suite on both backends.
11. Browser E2E on both backends.

Plus three consecutive runs of the new tests, Docker CI with every log inspected, and an independent re-audit.

## Suggested order and sizing
1. **Track C** (smallest, no external dependency, lowers risk for everything else).
2. **Track B** (fixes F7; no external dependency).
3. **Track A** (needs the Turnstile account for live use; can be built and tested with the stub and test keys first).
4. **Track E** whenever you provide the restricted key. It is independent of A–C, and it is the release blocker
   that most needs to move.
5. **Track D** items folded in where they touch the same code, or batched.

Rough size: A ≈ 900–1,200 lines, B ≈ 700–900, C ≈ 300–400 (including tests); E ≈ 400 plus workflow.

## What stays out of scope
Deployment, AWS provisioning, paid infrastructure, ASN/MaxMind, the upload system's implementation, paid queue tiers,
guest data deletion (retention stays a proposal), and the production release decision.

## Decisions requested
1. Authorize Phase 2.5 implementation, all tracks or a subset, and the order (recommended: C → B → A, with E in
   parallel when the key exists).
2. J2: option (a) or (b).
3. D2: add the Docker-level J1 guard test? (yes or no)
4. Track E: provide the restricted Gemini key in a `live-ai` environment and approve the first run.
