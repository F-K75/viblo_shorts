# Phase 2.5: Abuse Protection Implementation Plan (R-03 / R-04 / R-13)

> **Status: plan only. Not implemented. Waiting for your approval.**
> Starts only after PR #3 is reviewed and merged. Delivered as **its own PR**, branched from `main` after that merge.
> Validation follows docs/VALIDATION_STANDARD.md: red-first reproduction, non-vacuous assertions, a concurrency
> matrix, failure injection, abuse tests and an independent re-audit before the gate.
> Evidence tags: **[R]** reproduced in this repository · **[K]** vendor behaviour from prior knowledge. Vendor
> documentation hosts are blocked by this environment's network allowlist, so [K] items must be confirmed at
> implementation time.

## 0. Current state (facts from the code at PR #3 head 6fd474d)

| Risk | What the code does today | Reproduced |
|---|---|---|
| **R-03** guest mint | `POST /api/auth/guest`: per-IP bucket 10/min, plus **one global** hourly window `GUEST_MINT_PER_HOUR=1000` (`server.ts:83, 375-380`). A single client rotating IPs can spend the global budget and **block onboarding for everyone**. No CAPTCHA. | [R] still reproduces |
| **R-04** guest render | `POST /api/render/video` and `/api/jobs/create` accept guest tokens. Admission is 5 active jobs/user plus render minutes (`server.ts:1376`). Unlimited free guest identities × 5 jobs gives effectively unbounded ffmpeg CPU. Workers claim FIFO, so one user's backlog starves others. | [R] still reproduces |
| **R-13** body/memory | One global `express.json({limit:'1mb'})` (`server.ts:276`). There is no concurrency bound on large bodies and no memory guard. **No file-upload endpoint exists yet**; user uploads are an approved future feature. | [R] large-body flood raises RSS |

The UI never calls server render today (guests export client-side), so R-04 changes no current guest UX.

---

## 1. R-03: Guest registration protection

### 1.1 CAPTCHA choice: **Cloudflare Turnstile** (recommended)

| | Turnstile | Firebase App Check |
|---|---|---|
| What it proves | A human/browser solved a challenge (per request token) | The request comes from *your* registered app instance |
| Web provider | Itself (free [K]) | reCAPTCHA v3 / Enterprise underneath (Enterprise is paid above a free tier [K]) |
| Fit for a single unauthenticated mint endpoint | Direct: token in the mint request, verified server-side once | Designed to protect Firebase backends and needs the Admin SDK to verify tokens on our Express server. It attests app integrity, not humanness, and a scripted browser running our own page passes it. |
| Privacy | No cross-site tracking cookies [K] | reCAPTCHA has Google data-processing terms |
| Testability | Documented test site keys/secrets that always pass or fail [K] | Debug tokens |

**Recommendation: Turnstile on `/api/auth/guest`.** App Check can be added later as a second layer on AI
endpoints if scripted abuse moves there. It is not a substitute for the challenge.

**Design**
* Client: the Turnstile widget (invisible/managed mode) runs before the first guest mint and sends `cf-turnstile-response`.
* Server: a `CaptchaVerifier` interface with `TurnstileVerifier` (POSTs `secret`, `response` and `remoteip` to
  `https://challenges.cloudflare.com/turnstile/v0/siteverify`, 3 s timeout) and a `StubVerifier` (tests only).
  Each token is checked against `success`, `hostname ∈ ALLOWED_HOSTNAMES`, `action === 'guest_mint'`, and
  token age under 300 s.
* **Single use:** the token hash is stored in a `captcha_redemptions` table with a unique key and TTL. A replayed
  token gets 403. This holds across instances.
* **Failure mode:** if siteverify is unreachable, the server **fails closed for new guests** (503 `captcha_unavailable`)
  but keeps a small per-instance emergency budget (default 0, configurable). Existing guests and signed-in users
  are unaffected. A CAPTCHA outage never hits anyone who already has a session.
* Config: `TURNSTILE_SITE_KEY` (public, served via `/api/config`), `TURNSTILE_SECRET` (Secrets Manager; never
  logged), `CAPTCHA_REQUIRED` (default `true` in production; startup **refuses** production without a secret
  unless it is explicitly disabled).

### 1.2 Hierarchical budgets (replacing the single global counter)
All limits use PostgreSQL token buckets (database clock, cross-instance). The existing `takeRateTokens` is
reused with new keys.

| Scope | Key | Default | Purpose |
|---|---|---|---|
| Device | `dev:<sha256(device id)>`. The device id is a random value in an HttpOnly cookie plus localStorage, issued at first page load. | 3 mints / 24 h | Stops "clear token, mint again" loops from one browser |
| IP | `ip:<addr>` | 5 / h, burst 3 | Same as today but tighter, because CAPTCHA now carries the load |
| IPv4 subnet | `v4s:<a.b.c>/24` | 30 / h | Defeats rotation inside one allocation |
| IPv6 prefix | `v6s:<first 48 bits>` | 30 / h | IPv6 users get a /64 or more each, so per-address limits are meaningless |
| Global **soft** breaker | `guest-mint` window | 1000 / h (existing) | **Changed semantics:** once tripped, it raises the bar (a forced interactive challenge and halved per-subnet budgets) and alerts. It **no longer rejects** valid CAPTCHA-verified requests. |
| Global **hard** ceiling | `guest-mint-hard` | 10 000 / h | Protects storage only. It rejects with a clear message and a "sign in instead" path, and logs an alert. |

Why onboarding cannot be shut off: an attacker who spends the soft budget still has to solve one CAPTCHA per
mint, and each solve only spends that attacker's own device/IP/subnet budget. The hard ceiling is 10× normal
peak, and signed-in onboarding (Firebase) is never subject to it.

ASN-level budgets need a GeoIP/ASN database (MaxMind GeoLite2 licence). **Deferred.** They are noted as an
option and not built without your approval.

`TRUST_PROXY` must be set correctly (already documented in the PR #3 operational steps). Otherwise every
request looks like the load balancer's IP. A startup warning fires when production runs with `TRUST_PROXY` unset.

### 1.3 R-03 regression tests (red first against the current code)
1. **Global-lockout test (red today):** an attacker rotates 1 100 IPs (via `X-Forwarded-For` with trusted
   proxy) and mints until rejected. Then a fresh, CAPTCHA-verified victim mints. Today the victim gets 429.
   Afterwards the victim gets 200.
2. Missing, invalid, replayed (same token twice, across 2 instances), wrong-hostname, wrong-action and expired
   tokens each get 403, with zero guests created (asserted in the DB).
3. Per-device, per-IP, /24 and /48 budgets each hold exactly at N under 50 concurrent requests across 2
   instances (exactly N rows created).
4. Siteverify timeout or 5xx (failure-injected stub server): new mints get 503, and an existing guest's
   `/api/auth/me` still returns 200.
5. Production startup without `TURNSTILE_SECRET` and without explicit opt-out exits non-zero.
6. The secret never appears in logs, errors or `/api/config` (grep assertion on captured output).

---

## 2. R-04: Render queue protection

### 2.1 Policy
* **No server-side rendering for guests.** `POST /api/render/video`, `/api/jobs/create` and `/api/jobs/:id/retry`
  return `403 {error:'sign_in_required', ...}` for guest and legacy principals. Guests keep everything else:
  studio, scripts, project editing, client-side preview and client-side export (unchanged UI path). The UI shows
  "Sign in to render on our servers" only where a server render is offered.
* No paid-priority claims anywhere (UI copy, API, docs) until billing exists. All signed-in users get the same
  scheduling class.

### 2.2 Admission and scheduling

| Control | Design | Default |
|---|---|---|
| Per-user concurrent **running** | At most K jobs in `processing` per user, enforced in the claim query | 1 |
| Per-user **queued** | Admission under the user row lock (existing ADR-007 mechanism) | 3 (down from 5) |
| Global queue capacity | Admission counts all `queued` jobs. Above the cap it returns **429 `queue_full` with `Retry-After`** (backpressure, not unbounded growth). | `RENDER_QUEUE_MAX=200` |
| Per-instance worker concurrency | Semaphore around ffmpeg | `RENDER_WORKERS=os.cpus()/2` (≥ 1) |
| Fair scheduling | The claim picks the oldest queued job **of the user with the fewest running jobs, ties broken by that user's oldest waiting job** (round-robin across users), with `FOR UPDATE SKIP LOCKED`. A single SQL statement with a `DISTINCT ON (user_id)` candidate set: no starvation, because every user's head job ages and the per-user running cap stops monopolisation. | — |
| Wall-clock timeout | Worker kills ffmpeg after `RENDER_TIMEOUT_S` (proportional to output duration, capped). Job is `failed: timeout`, and render minutes are refunded. | 3 × duration, ≤ 600 s |
| Queue-wait timeout | Jobs queued longer than `RENDER_QUEUE_TTL_S` are failed `expired` and their minutes released | 1800 s |
| Cancellation | Existing heartbeat-observed cancel (works cross-instance). Cancelling a queued job releases its reserved minutes immediately. | — |
| Input limits | Duration ≤ 180 s, resolution ≤ 1080×1920, beats ≤ 60, total asset bytes bounded. Validated before admission. | — |

Index added: `jobs(status, user_id, created_at)`, in a new **append-only migration `0003`** (expand-only, safe
under rolling deploy).

### 2.3 R-04 regression tests
1. **Guest render (red today):** a guest gets 202 from `/api/render/video` today; afterwards 403
   `sign_in_required`, with zero jobs and zero ffmpeg processes spawned (spawn counter).
2. Guests' client-side export path and project editing are unaffected (existing E2E plus an assertion).
3. **Starvation (red today):** user A enqueues 3 jobs, then B enqueues 1, with 1 worker. Today B is 4th.
   Afterwards B is claimed 2nd. A 3-user × 3-job matrix asserts round-robin order.
4. Global cap: 2 instances × 300 concurrent admissions from many users give exactly `RENDER_QUEUE_MAX`
   accepted, the rest 429 with `Retry-After`. Counters are exact.
5. Timeout: a stub "ffmpeg" that hangs gets killed at the deadline, the job ends `failed: timeout`, minutes are
   refunded, and no zombie process remains.
6. Cancellation of queued and running jobs across instances releases minutes exactly once (duplicate cancel is a no-op).
7. Queue-wait expiry under a stopped worker pool.

---

## 3. R-13: Request bodies, memory and uploads

### 3.1 Now (no upload endpoint exists)
* **Route-specific body limits** replace the global 1 MB:
  * projects 512 KB (current max doc size + margin);
  * AI text endpoints 32 KB;
  * transcript parse 256 KB;
  * TTS 8 KB;
  * everything else 16 KB.
  * Over-limit bodies get 413 before parsing. The limit is checked against `Content-Length` and enforced while
    streaming for chunked bodies.
* **Concurrent large-body semaphore:** at most `BODY_CONCURRENCY` (default 16) in-flight bodies over 64 KB per
  instance. Excess gets 503 `busy` with `Retry-After`.
* **Memory guard:** when `process.memoryUsage().rss` exceeds `MEMORY_SOFT_LIMIT_MB`, new body-heavy and render
  requests get 503 and `/api/ready` reports not-ready (the LB drains the instance). It recovers automatically
  below 90 % of the limit.
* Server timeouts: `headersTimeout`/`requestTimeout` set explicitly (slow-loris).

### 3.2 Upload module (designed now; ships with the user-upload feature, reusing the same guards)
* **Signed-in only.** Guests cannot upload. Uploads go to **S3 via pre-signed POST** with a
  `content-length-range` condition, so file bytes never pass through the API instance's memory. Where the
  server must proxy (local dev), it streams with `busboy` into a temp file, with byte counting that aborts at
  the limit. It never buffers.
* Limits: video ≤ 200 MB, image ≤ 10 MB, audio ≤ 25 MB; ≤ 2 concurrent uploads per user, ≤ 20 per hour; and a
  per-user storage quota (reusing the `users.storage_bytes` accounting).
* **Validation:** an allow-list of MIME types, **magic-byte sniffing** of the first bytes (the declared type must
  match the sniffed type), then `ffprobe` with a timeout for media (duration, codecs, dimensions ≤ limits).
  Files are rejected on mismatch. SVG, HTML and executables are never accepted.
* **Lifecycle:** an upload is `pending` until validated. Failed or abandoned uploads are deleted, both by a
  sweeper (pending older than 1 h) and by an S3 lifecycle rule on the `pending/` prefix as a backstop. Temp
  files are removed in `finally` and on process start.

### 3.3 R-13 regression tests
1. **Red today:** a 900 KB body to `/api/tts` is parsed (200/400 after full buffering). Afterwards it gets 413,
   and the handler is never invoked.
2. 50 concurrent 1 MB bodies: RSS growth stays bounded (asserted under a threshold), the excess gets 503, and
   the process stays healthy.
3. A chunked body without `Content-Length` over the limit gets 413 with the connection closed.
4. Memory-guard injection (stubbed RSS reader): 503 plus `/api/ready` not-ready, then recovery.
5. Upload module unit and integration tests (against MinIO in CI):
   * spoofed MIME (PNG header named `.mp4`) is rejected;
   * oversize aborts mid-stream without writing more than the limit plus one chunk;
   * a killed connection leaves no temp file;
   * the sweeper removes stale pending uploads.

---

## 4. Delivery plan

| Step | Commit(s) | Gate |
|---|---|---|
| 1 | Red-first tests for R-03/R-04/R-13 (marked expected-fail), so CI shows them failing on the old code | Red evidence recorded |
| 2 | R-03: verifier, redemption table (migration 0003a), hierarchical budgets, breaker semantics, client widget | R-03 tests green |
| 3 | R-04: guest render block, admission caps, fair claim, timeouts, migration 0003b index | R-04 tests green |
| 4 | R-13: route limits, semaphore, memory guard, server timeouts | R-13 tests green |
| 5 | Upload module skeleton (library plus tests; **no public route** until the upload feature) | Module tests green |
| 6 | Docs: ADR-010 (abuse model), `.env.example`, runbook (CAPTCHA outage, queue-full alerts), RELEASE_REAUDIT update | Independent re-audit |

* Branch: `claude/keen-feynman-xtbvz2-phase2-5` from `main` after PR #3 merges. **One PR**, scoped to these
  three risks only.
* Full suite on both backends, E2E on both, a load test (adding a guest-mint storm and a render-admission
  storm), and the Docker two-instance smoke.
* Estimated size: about 1 500–2 000 lines including tests.

## 5. Decisions needed before implementation
1. Approve **Turnstile** (vs App Check). You will need to create a Turnstile widget in a Cloudflare account (free
   [K]) and put the secret in GitHub Actions secrets or Secrets Manager. I never handle the value.
2. Approve the default numbers in §1.2 and §2.2, or adjust them.
3. Device-id cookie: a first-party, HttpOnly, random-id cookie used only for abuse limits. Confirm the privacy
   policy may mention it (strictly-necessary/security purpose).
4. ASN budgets (needs a MaxMind licence): defer (recommended) or include.

---

## 6. Queued after Phase 2.5 (design notes only; separate PRs)

### 6.1 Phase 3, first item: live Gemini end-to-end workflow
Goal: prove the milestone **project → Gemini script and assets → render → preview → export a playable MP4**
with real calls. A mocked response does not count.

* `.github/workflows/live-ai.yml`, **`workflow_dispatch` only** (manual), `environment: live-ai` with
  required reviewers (you), `concurrency: live-ai`, and a 20-minute timeout. It never runs on PRs from forks
  and never on push.
* The secret is `GEMINI_API_KEY_LIVE` in the `live-ai` environment: a **restricted key** (Generative Language
  API only, with a low daily quota set in Google Cloud). You create it; it is never pasted into chat. It is
  passed only as an env var to the server process, never echoed, and `::add-mask::` is applied defensively. The
  test asserts the key string does not appear in any artifact or log it uploads.
* `tests/live/live_pipeline.test.ts` (skipped unless `LIVE_AI=1`) drives the **real UI flow via Playwright**
  plus API checks:
  1. sign in a test account (Firebase test project, or a dedicated test user);
  2. create a project;
  3. `/api/generate-script` must return model output (`source: 'gemini'`, not a fallback). The test fails on a
     fallback.
  4. generate assets (TTS/voice and any AI metadata endpoints in use);
  5. run the server render job to completion;
  6. download the MP4, then `ffprobe` it: has a video stream, duration ±10 % of planned, an audio stream if
     narration, non-black frames sampled;
  7. assert the preview element plays (`currentTime` advances);
  8. export/download via the UI download button, with a byte-equal check against the API file.
* Captured to a JSON artifact: per-call latency, `usageMetadata` token counts (prompt/candidates/total),
  estimated cost from a pricing table checked into the repo (dated, marked as an estimate), model id,
  error/fallback counts, render time, and MP4 size and duration.

### 6.2 Phase 4 prep: AWS architecture and cost (documentation only, no provisioning)
To deliver before any paid resource exists:
* an architecture diagram covering:
  * ALB;
  * the compute choice (ECS Fargate recommended over App Runner, because of ffmpeg CPU control, job workers
    as a separate service, and private networking; EKS is overkill);
  * RDS PostgreSQL Multi-AZ in ap-south-1, in private subnets and reached only from the app security group;
  * RDS Proxy vs in-app pool;
  * S3 for renders and uploads;
  * an independent backup bucket in a second region/account with Object Lock;
  * KMS CMKs;
  * Secrets Manager;
  * CloudWatch alarms;
  * VPC endpoints;
* monthly cost estimates for dev, staging and prod;
* verification of Mumbai-region service availability and recovery capabilities (PITR window, cross-region
  snapshot copy, Multi-AZ failover time) against AWS documentation. This environment cannot reach
  docs.aws.amazon.com, so the figures will be marked [K] until you or a session with access confirms them.
