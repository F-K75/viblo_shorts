# Phase 2.5 Track C: Memory Protection and Backpressure (R-13): Evidence Package

> **Scope:** request bodies, memory and slow clients only (Track C of `PHASE2_5_EXECUTION_CHECKLIST.md`). Branch
> `claude/keen-feynman-xtbvz2-track-c` from `main` @ `be4c48e`. **Not merged; your approval is required.** No
> deployment, no AWS, no paid services. Release assessment unchanged: NOT READY (58/100, provisional).

## 1. Findings and root causes
| # | Finding (R-13) | Root cause in `main` @ `be4c48e` |
|---|---|---|
| C-a | Any endpoint accepted and parsed a 1 MB JSON body (e.g. a 100 KB body to `/api/tts`, whose text is capped at 1,000 characters) | One global `express.json({ limit: '1mb' })` for every route |
| C-b | Anonymous clients could make the server buffer a 1 MB body per request: the 401 came only after the whole body was read (1,916 ms for a ~2 s trickle) | The JSON parser ran **before** the authentication middleware |
| C-c | No backpressure: any number of large bodies were buffered at once (12 slow uploads: all accepted at once) | No admission control for large bodies |
| C-d | No memory guard: nothing slowed intake or drained the instance under memory pressure | Readiness did not consider memory |
| C-e | Slow clients were never cut off (slow headers and slow bodies still open after 12 s) | Node defaults, checked only every 30 s (`headersTimeout` 60 s, `requestTimeout` 300 s) |

## 2. Body inventory (why the limits differ from the original plan)
I read what every POST route accepts and what the frontend actually sends:
* `/api/gemini/optimize-metadata` and `/api/publish/generate-pack` send the **whole `script.beats`** array. The
  planned 32 KB "AI text" limit would have broken them for real projects, so they get the **project** limit.
* Pasted transcripts (`parse-transcript`, `generate-clips`) are truncated by the server **after** parsing (50,000 /
  30,000 characters). Lowering their 1 MB transport limit would turn today's silent truncation into a hard error,
  so they keep **1 MB**. Their memory is bounded by the concurrency limit instead.

| Route group | Limit (env) |
|---|---|
| `/api/projects`, `/api/publish/generate-pack`, `/api/gemini/optimize-metadata`, `/api/render/video`, `/api/jobs/create` | `PROJECT_MAX_KB` (512) + 64 KB |
| `/api/youtube/parse-transcript`, `/api/youtube/generate-clips` | `BODY_LIMIT_TRANSCRIPT_KB` = 1024 |
| `/api/voice-to-text/transcribe-clip`, `/api/voice-to-text/align-words` | `BODY_LIMIT_MEDIUM_KB` = 64 |
| Everything else | `BODY_LIMIT_DEFAULT_KB` = 16 |

## 3. Fix (`server/lib/requestGuards.ts`, wiring in `server.ts`)
1. **Bodies are read only after authentication.** JSON parsing moved behind the header-based auth middleware. An
   anonymous request gets 401 without its body being parsed or buffered. No public route takes a body.
2. **Route-specific limits.** A `Content-Length` above the route limit gets `413 payload_too_large` before a byte is
   read. Chunked bodies are cut off by the JSON parser at the same limit while streaming.
3. **Backpressure.** At most `BODY_CONCURRENCY` (16) bodies larger than `LARGE_BODY_KB` (64), or chunked, are in
   flight per instance. A slot is held until the response finishes, because the parsed body lives that long.
   The excess gets `503 busy` + `Retry-After: 2`. Worst-case body memory per instance ≈ 16 × the route limit.
4. **Memory guard.** RSS is sampled every second.
   * Above `MEMORY_SOFT_LIMIT_MB` (default 80 % of the container cgroup limit, else of host memory), large-body
     and render requests (`/api/render/video`, `/api/jobs/create`, `/api/jobs/:id/retry`) get
     `503 memory_pressure` + `Retry-After: 5`.
   * `/api/ready` reports `checks.memory: false`, so the load balancer drains the instance.
   * Liveness stays 200, so the instance is not restarted.
   * It recovers below 90 % of the limit; this hysteresis prevents flapping.
5. **Slow clients.** The HTTP server is created with `headersTimeout` (20 s), `requestTimeout` (60 s; whole request
   incl. body, responses unaffected) and a 1 s checking interval, so the limits are enforced promptly.
6. **Refusals never close the connection early.** Node discards any unread remainder (no memory; bounded by
   `requestTimeout`), so a client that is still uploading still receives its 413/503 and message. An earlier
   version closed the connection; the full-suite run showed a client getting `EPIPE` instead of the 413, and it
   was changed.
7. **Observability.** `/api/health/details` (gated) shows:
   * under `requests`: the in-flight count, the high-water mark and the counts of admitted, too-large, busy and
     memory refusals, plus the timeouts;
   * under `system.memoryGuard`: the limit, the state, the last RSS and the trips.

All settings are documented in `.env.example`.

## 4. Red → green evidence (`tests/memory_protection.test.ts`, 8 tests, real server processes)
| Test | Before (`be4c48e`, commit `4874822` has the tests only) | After |
|---|---|---|
| 100 KB body to `/api/tts` | **200** (parsed) | 413 `payload_too_large` |
| Same, chunked | **200** | 413 while streaming |
| Legitimate payloads (480 KB project, whole-script optimize-metadata, ~800 KB pasted transcript) | 200 / not 413 | unchanged (guard against regressions) |
| Anonymous 400 KB upload trickled over ~2 s | 401 after **1,916 ms** (body read first) | 401 immediately (well under 900 ms) |
| 12 concurrent slow 300 KB uploads, `BODY_CONCURRENCY=3` | **all 12 accepted at once** | ≤ 3 in flight, the rest `503 busy` + `Retry-After`; capacity returns afterwards |
| Memory guard (injected RSS) | readiness **never drains** | 503 for large and render requests, readiness 503 (`memory: false`), small requests and liveness OK; recovers only below 90 % |
| Headers trickled 1 byte / 400 ms | **never closed** (12 s) | closed by `HEADERS_TIMEOUT_MS` |
| Body trickled 1 byte / 400 ms | **never closed** (12 s) | closed by `REQUEST_TIMEOUT_MS` |
| **Exit criterion:** 60 slow 450 KB + 20 oversized 2 MB uploads + 20 slow-header connections at once | **+102.1 MB RSS**, all 60 buffered at once | **+15.2 to +18.5 MB RSS** over 5 runs, ≤ 4 large bodies in memory, every oversized upload gets its 413 |

The "before" RSS figure was measured with the same load against the unmodified `server.ts` of `be4c48e` (§6).

## 5. Behaviour changes (review these)
* Under overload, saves and other large requests can get `503 busy` / `memory_pressure` instead of being buffered.
  The frontend shows the server's message ("…busy… Please retry shortly."); the project stays in the browser. The
  client does **not** retry automatically yet (follow-up below).
* Over-limit bodies now get 413 on small-payload routes (previously parsed up to 1 MB and truncated or rejected by
  the handler).
* `/api/ready` has a new `checks.memory`. The existing readiness test was updated to the new shape.
* Anonymous requests to protected routes get 401 without their body being read.

## 6. Validation
**Local, final code:**
* typecheck ✅;
* JSON-backend suite **180 tests: 178 pass, 0 fail, 2 skipped** (live Gemini, no key, NOT passed);
* PostgreSQL-backend suite **180: 171 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific);
* build ✅;
* E2E 1/1 on both backends.

**Track C tests, three consecutive runs:**

| Run | Backend | Result | RSS growth (exit criterion) |
|---|---|---|---|
| 1 | JSON | 8/8 | +18.5 MB |
| 2 | PostgreSQL | 8/8 | +17.1 MB |
| 3 | JSON | 8/8 | +17.8 MB |

**Before/after measurement:** the exit-criterion load against the unmodified `server.ts` of `be4c48e` gave
`{"rssBeforeMb":94.5,"rssAfterMb":196.6,"growthMb":102.1,"statuses":{"200":60,"413":20}}`. With Track C:
`{"growthMb":15.2…18.5,"statuses":{"200":4,"413":20,"503":56}}`. That is roughly 6× less memory under the same
attack, with every refusal answered.

**Found during the gate and fixed before the PR:** the first full-suite run showed (a) one oversized upload getting
`EPIPE` instead of its 413, because the refusal closed the connection early (§3.6), and (b) the existing readiness
test asserting the old exact `checks` shape (§5).

**CI:** recorded on the PR after the run, with the logs inspected.

## 7. Remaining risks and follow-ups
* **Client retry for 503 busy / memory_pressure** (safe: those answers come before any handler runs). Not added here
  because the frontend has no unit tests (R-23). Recommended as a small, tested follow-up.
* The memory guard watches the Node process RSS. ffmpeg render children are separate processes. Their memory is
  bounded by Track B (one running render per user, a global queue cap), not by this guard.
* Rate limiting runs after body admission. A body that passes admission is read before the per-route rate limit
  is checked. It is bounded by the route limit and the concurrency cap.
* R-13's earlier note of "1 to 6 unexplained dropped sockets" under load was not reproduced or explained in this
  track. It stays open.

## 8. Corrections requested in review (2026-11-02): REQUEST CHANGES on PR #4
### 8.1 Correction 1: the memory guard accounts for ffmpeg render memory
* **Finding:** ffmpeg renders are separate processes. Their memory is never part of Node's RSS but counts against the
  same container limit. Measured worst case: a 60 s 1080p render with 40 captions peaked at **169 MB**. The old
  default threshold (80 % of the container, applied to Node alone) let Node reach ~819 MB in a 1 GB container
  while two renders (~340 MB) ran beside it, so the kernel could kill the container before the guard reacted.
* **Fix (`computeMemoryBudget`):** `L = floor(0.8 x M - R x S)`.
  * `M`: the container memory (cgroup, or `MEMORY_CONTAINER_LIMIT_MB`, else host memory).
  * `R`: `MAX_CONCURRENT_RENDERS`.
  * `S`: `RENDER_MEMORY_RESERVE_MB`, default 256.
  * 1 GB, 2 renders → **307 MB** for Node; with 1 render → 563 MB.
* **No double counting:**
  * an explicit `MEMORY_SOFT_LIMIT_MB` is used as-is, with no reserve subtracted;
  * Node's RSS covers only the Node process, never the ffmpeg children.
* **Invalid or insufficient budgets stop the server at startup** with an explanation. Examples:
  * 512 MB with 2 renders, because nothing is left for Node;
  * 768 MB with 2 renders, which leaves 102 MB, under `MEMORY_MIN_NODE_MB` (192);
  * a non-numeric or fractional `MAX_CONCURRENT_RENDERS`, which previously became `NaN` and would have disabled the
    guard silently;
  * negative values.
* `/api/health/details` → `system.memoryGuard` now shows the budget: `softLimitMb`, `source`, `memoryMb`,
  `reservedForRendersMb`, `maxConcurrentRenders` and `renderReserveMb`.
* **Limitation:** the reserve is a planning number, not a hard cap on ffmpeg. A render using more than its reserve
  is not stopped by this guard (Track B adds per-job timeouts). The 256 MB default is 1.5× the measured worst case.

### 8.2 Correction 2: recovery from REAL memory pressure
The earlier recovery test used injected RSS values. The new test allocates **genuine** memory inside the server
process (8 MB buffers filled with non-zero bytes, so the pages are really resident). It uses a test-only hook that
exists only when `NODE_ENV=test` **and** `MEMORY_TEST_HOOKS=1`; a test asserts the hook is absent otherwise. The
test then:
1. takes the baseline (real RSS ~99 MB) with the limit at 400 MB, and checks readiness is 200;
2. retains 450 MB: real RSS ~561 MB → the guard trips **on the sampler's real reading**, readiness is 503
   (`checks.memory: false`), and a large request gets `503 memory_pressure`;
3. releases the buffers and runs `gc()` twice (`--expose-gc`): real RSS falls to ~105 MB;
4. polls: readiness returns to 200 **only** when the guard's real reading is below 360 MB (90 %), and every
   earlier poll was 503. A large request then succeeds.

Thresholds were not changed to make it pass. **Result: Node did release the memory** for Buffer allocations (the
kind request bodies use). This was not measured for retained JS-heap objects; V8 may keep heap pages longer, which
could keep an instance drained. That stays listed as a risk.

### 8.3 Red → green
| Test | Before (PR head `b0328ad`; tests-only commit `3a11c7b`) | After |
|---|---|---|
| Budget unit tests (7) | fail: `computeMemoryBudget` does not exist | pass |
| 1 GB / 2 renders in the running server | **threshold 12,873 MB** (80 % of host memory) | 307 MB; guard and readiness act at 320 MB, stay guarded at 290 MB (hysteresis), recover at 250 MB |
| Reserve override / explicit override | (no reserve concept) | 563 MB / 700 MB explicit, nothing subtracted |
| 512 MB container, 2 renders; `MAX_CONCURRENT_RENDERS=abc` | **server starts anyway** | refuses to start with an explanation |
| Real memory recovery | fails only because the hook does not exist (**a trivial red**: the guard logic it exercises already existed) | pass with genuine RSS: 561 → 105 MB, readiness back only below 360 MB |
| Hook absent without the flags | pass | pass |

### 8.4 Intermittent `EPIPE` in the exit-criterion test (investigated, not changed: outside the two corrections)
* **Seen:** twice in about 20 full-suite runs, one oversized upload in the exit test was recorded as `write EPIPE`
  instead of its 413.
* **Server side ruled out:** in 1,600 controlled oversized uploads (fast and trickled, `Connection: close` and
  keep-alive clients), every client received its 413.
* **Most likely cause:** the test's own `send()` helper. After a socket error it waits only 50 ms for the response;
  under full-suite load the 413 can take longer than that to be processed, so the helper records the error. This
  is a hypothesis consistent with all observations, not proven.
* **Proposed fix (for your decision):** let `send()` wait for the response up to the request timeout after a write
  error, still requiring a 413. No server change.

### 8.5 Validation of the corrections (local)
| Run | Backend | Correction tests (7 unit + 5 server) | Real RSS held → after release | Recovered |
|---|---|---|---|---|
| 1 | JSON | 12/12 | 564.1 → 107.8 MB | yes |
| 2 | PostgreSQL | 12/12 | 566.0 → 109.7 MB | yes |
| 3 | JSON | 12/12 | 571.6 → 114.9 MB | yes |

* Full suites: JSON **192 tests: 190 pass, 0 fail, 2 skipped**; PostgreSQL **192: 183 pass, 0 fail, 9 skipped**.
* Typecheck ✅, build ✅, E2E 1/1 on both backends.
* A first gate run failed only with `ECONNREFUSED 127.0.0.1:55432` (52×): the local test database had stopped (a
  container recycle). It passed after a restart with no code change.

### 8.6 Risk register (Track C)
| Risk | Status |
|---|---|
| ffmpeg memory outside the guard | **Mitigated** by the render reserve (correction 1). Residual: the reserve is a planning number, not a hard cap per render |
| Guard never exercised on real memory | **Closed for Buffer memory** (correction 2). Residual: retained JS-heap objects not measured; V8 may keep pages longer |
| Intermittent `EPIPE` in the exit test | **Open**; test-helper hypothesis (§8.4); fix proposed, not applied (out of scope) |
| No automatic client retry on 503 | **Open** follow-up (`Retry-After` is always sent) |
| Dropped sockets (R-13 note) | **Open**: not reproduced in 7 + 6 bursts (§ PR review) |
| No Docker-level test of Track C | **Open**, Track D |
| Live Gemini | **Open**, release blocker R-01 |
