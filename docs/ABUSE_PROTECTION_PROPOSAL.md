# Free-tier Abuse Protection — Implementation Proposal (R-03, R-04, R-13)

> Status: **proposal for approval; not implemented.** Target milestone: **Phase 2.5 — abuse protection and
> concurrency.** These issues block public release.

## 1. What the re-audit proved (production defaults, PostgreSQL)

| ID | Attack | Measured | Who is harmed |
|---|---|---|---|
| R-03a | Exhaust the global guest sign-up budget (1,000/h) | 1,000 mints from 1,000 IPs in **2 s**; then every new visitor gets `429 guest_capacity` | All new visitors, for the rest of the hour |
| R-03b | Fill the 512 MB guest storage pool | **32 s** with those guests (1,037 × 500 KB) | All guests (saves larger than the remaining headroom fail) |
| R-04 | Queue renders from free guests | 100 guests → **500 × 60 s 1080p jobs in 1.5 s**; a signed-in user's job still queued after 20 s | Every user of server renders; instance CPU |
| R-13 | Many concurrent large bodies | ~250 × 500 KB → heap ~308 MB / RSS 443 MB, 6 dropped connections | Whole instance (OOM risk at the 1 GB limit) |

**Design principle:** IP limits alone are insufficient (botnets, NAT, IPv6 /64 rotation). Each defence is
layered: **identity cost** (it must cost something to obtain a guest identity), **per-principal fairness** (one
principal cannot take more than its share), **global backpressure** (bounded queues, admission control), and
**detection and alerting**.

## 2. Proposed controls

### 2.1 Guest identity cost (R-03a)
1. **Proof-of-humanity on guest mint:** Firebase App Check with reCAPTCHA Enterprise or Cloudflare Turnstile. The
   server verifies the token before issuing a guest session. A mint without a valid token gets `403`.
2. **Hierarchical budgets** instead of one global counter (all in PostgreSQL, shared across instances):
   per IP (10/min, 50/day), per IPv4 /24 and IPv6 /48 (e.g. 100/h), per ASN for known hosting/datacenter ASNs
   (much lower), and the global budget kept only as a last-resort circuit breaker.
3. **The global breaker no longer locks out humans:** when the breaker trips, minting still succeeds for
   requests with a fresh, high-score CAPTCHA token. Only unverified traffic is shed.
4. **Guest session binding:** guest tokens are bound to the App Check token's device or app instance, so
   tokens cannot be farmed and replayed elsewhere.

### 2.2 Guest storage (R-03b)
1. Lower guest limits: **3 projects / 2 MB** (configurable). Guests still have enough to try the product.
2. **Per-subnet storage caps** (/24, /48) on top of per-guest caps.
3. Pool reclamation through the **retention policy** (30 days of inactivity → soft expiry; see
   `GUEST_DATA_RETENTION_PROPOSAL.md`), once approved.
4. Signed-in users stay outside the guest pool (already true and tested).

### 2.3 Render fairness and resource protection (R-04)
1. **Guests cannot create server render jobs** (`403 sign_up_required`). The UI does not use server renders today.
2. **Max concurrent jobs per user:** 1 running + 2 queued (currently 5 active). Signed-in free: 1 + 2; paid
   (later): higher.
3. **Fair queueing:** the claim order becomes *round-robin by user*, with priority classes (paid > signed-in >
   guest, if guests are ever allowed). Implementation: `claimNextJob` selects the oldest queued job of the user
   with the fewest running jobs (`SKIP LOCKED` retained). A per-class weighted share prevents starvation.
4. **Global admission control:** a cap on total queued jobs (e.g. 200). Beyond it, `503 queue_full` with
   `Retry-After`. The queue depth is exported as a metric with alerts.
5. **Isolate render CPU:** run renders on separate worker instances (Phase 4; also fixes FS-037 with object
   storage), so web latency is unaffected by render load. Until then, a cgroup CPU share for ffmpeg (`nice`, and
   `cpu.max` in the container).

### 2.4 Request bodies and memory (R-13)
1. **Route-specific body limits:** 512 KB only on `POST /api/projects`; 64 KB elsewhere; 16 KB for AI endpoints
   (they accept short text).
2. **Concurrency admission for large bodies:** a semaphore around body parsing for requests above 64 KB (e.g. 32
   concurrent per instance). Excess requests wait briefly, then get `503`, so memory is bounded at roughly
   32 × 512 KB × parse overhead.
3. **Streaming-friendly parsing:** reject on `Content-Length` before reading; abort on an over-limit stream
   (Express already aborts at the limit; the semaphore prevents many in flight at once).
4. **Process memory guard:** when heap use exceeds a threshold (e.g. 70 % of the container limit), shed new
   heavy requests (`503`) until it recovers. Export heap metrics.
5. **Root-cause the 6 dropped connections** seen in the probe before declaring R-13 fixed.

### 2.5 Detection and response
* Metrics and alerts: mint rate by /24 and ASN, CAPTCHA failure rate, guest pool usage, render queue depth by
  class, 429/503 rates, heap usage.
* Automatic temporary blocks of subnets that exceed thresholds (stored in PostgreSQL, shared across instances,
  with expiry).
* An admin kill-switch to pause guest minting or server renders instantly (environment variable or DB flag).
* An edge layer (Cloudflare or AWS WAF) for volumetric DDoS. Application limits are not a substitute.

## 3. Validation plan (each control gets a red-first regression test)
| Control | Test |
|---|---|
| CAPTCHA on mint | Mint without/with an invalid token → 403; with a valid (test-mode) token → 200 |
| Hierarchical budgets | 1,000 mints from one /24 → blocked at the /24 cap; a different /24 still mints |
| Breaker does not lock out humans | After exhausting unverified budget, a verified mint succeeds |
| Guest render ban + per-user caps | Guest job create → 403; user job caps enforced across 2 instances concurrently |
| Fair queue | 500 jobs from 100 users + 1 job from a new user ⇒ the new user's job starts within ≤ 1 render slot |
| Body limits + semaphore | 1,000 concurrent 1 MB bodies → process alive, RSS bounded, excess 503s, 0 dropped sockets |
| Re-run of the re-audit probes (`/tmp/probe/abuse.mts`, `renderq.mts`) | All four attacks fail to harm a legitimate user |

## 4. Dependencies and decisions needed
1. CAPTCHA provider: **Firebase App Check + reCAPTCHA Enterprise** (fits the existing Firebase) or **Cloudflare
   Turnstile** (if Cloudflare is at the edge).
2. Approve **no server renders for guests** and the lower guest limits (3 projects / 2 MB).
3. Edge/WAF choice (depends on the hosting platform; see `DATABASE_PROVIDER_COMPARISON.md`).
