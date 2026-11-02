# API Inventory

Auth column: **public** = no token; **user** = valid Firebase ID token or guest token required.
Rate limits are per client IP per route group (token bucket / minute). **AI** = also consumes the user's daily plan quota.

| Method | Path | Auth | Limit | Purpose |
|---|---|---|---|---|
| GET | /api/health | public | – | Liveness: uptime, memory, AI metrics, render queue |
| GET | /api/ready | public | – | Readiness: storage writable + ffmpeg present (503 otherwise) |
| GET | /api/config | public | – | Feature flags (key presence only, never values) |
| POST | /api/auth/guest | public | 10 | Issue signed guest session |
| GET | /api/auth/me | user | 60 | Resolved identity |
| GET | /api/quota | user | 60 | Plan + usage |
| GET | /api/user/subscription | user | 60 | Subscription |
| POST | /api/user/subscription/upgrade | user | 10 | 501 unless `BILLING_MODE=demo` |
| GET | /api/projects | user | 120 | Own projects + read-only sample |
| GET | /api/projects/:id | user | 120 | 404 if not owner |
| POST | /api/projects | user | 60 | Create/update (field allowlist, 512 KB cap, 200/user) |
| DELETE | /api/projects/:id | user | 60 | Owner/admin only |
| POST | /api/projects/:id/duplicate | user | 60 | Copy own or sample |
| POST | /api/render/video | signed-in user | 10 | Caption render through the job queue; waits for the job (`RENDER_SYNC_WAIT_S`, default 50 s, then 202 + job id). Guests 403 `sign_in_required`; 429 `user_queue_full` / `queue_full` + Retry-After; 402 minutes exhausted. Client disconnect cancels the job |
| GET | /api/render/download/:renderId | capability URL | – | MP4 download, Range/416 |
| GET | /api/render/probe/:renderId | user | 60 | Metadata |
| GET | /api/jobs | user | 120 | Own jobs |
| POST | /api/jobs/create | signed-in user | 20 | `render_video` / `render_short` only. Guests 403 `sign_in_required`; per user 1 running + 3 queued (429 `user_queue_full`); global queue cap (429 `queue_full`); both with Retry-After |
| GET | /api/jobs/:id | user | 240 | Owner only |
| POST | /api/jobs/:id/cancel | user | 60 | Kills ffmpeg |
| POST | /api/jobs/:id/retry | signed-in user | 20 | Failed/cancelled only; real re-render; same admission limits as create |
| POST | /api/publish/generate-pack | user | 30 | Platform copy + SRT/VTT |
| POST | /api/tts | user | 25 AI | Gemini TTS (or `fallback: true`) |
| POST | /api/generate-script | user | 15 AI | Script JSON (`source`, `isFallback`) |
| POST | /api/gemini/rewrite-beat | user | 30 AI | Rewrite (`unchanged` when AI down) |
| POST | /api/gemini/suggest-hooks | user | 30 AI | 3 hooks |
| POST | /api/gemini/optimize-metadata | user | 30 AI | Titles/description/hashtags |
| POST | /api/stock-footage | user | 60 | Pexels or curated library |
| POST | /api/youtube/info | user | 60 | oEmbed metadata; 400 for non-YouTube input, 404 for missing video |
| POST | /api/youtube/captions | user | 40 | Real CC segments |
| POST | /api/youtube/parse-transcript | user | 60 | Parse pasted transcript |
| POST | /api/youtube/generate-clips | user | 15 AI | Clip strategies (`grounded`, `groundingWarning`) |
| POST | /api/voice-to-text/transcribe-clip | user | 30 | Real CC or estimated-from-text; 422 otherwise |
| POST | /api/voice-to-text/align-words | user | 60 | Deterministic timing estimate (no LLM) |
| * | /api/* (unknown) | – | – | JSON 404 (after auth) |

Error shape: `{ "error": string, "code"?: string }`. 500s include `requestId` (matching the `X-Request-Id` header and logs), never stack traces.

## Server rendering contract (Track B)

**Who:** only signed-in accounts. Guests get `403 {code: "sign_in_required"}` from `/api/render/video`,
`/api/jobs/create` and `/api/jobs/:id/retry`; nothing is queued or spawned for them.

**One path:** every server render goes through the job queue. The queue worker is the only code that starts an
encoder (tested: `tests/billing_recovery.test.ts` S1). The same rules apply to both endpoints.

| Rule | Behaviour |
|---|---|
| Admission (checked when the request arrives; nothing is queued when refused) | per user: 1 running + 3 waiting → `429 {code: "user_queue_full"}` + `Retry-After: 30`; all users: `RENDER_QUEUE_MAX` waiting → `429 {code: "queue_full"}` + `Retry-After: 60`; monthly minutes, counting the user's running and waiting jobs → `402 {quotaExceeded: true}` |
| Order | the waiting job of the user served least recently starts first; FIFO within one user; no priority tiers |
| Concurrency | `MAX_CONCURRENT_RENDERS` per **instance**; deployment-wide: instances × `MAX_CONCURRENT_RENDERS` |
| Execution limit | a render running longer than `clamp(RENDER_TIMEOUT_FACTOR × video seconds, RENDER_TIMEOUT_MIN_S, RENDER_TIMEOUT_MAX_S)` (default 3×, 60–600 s) is killed → job `failed`, error "Render timed out after N s" |
| Waiting limit | a job still waiting after `RENDER_QUEUE_TTL_S` (default 1800 s) → `failed`, "Expired: waited too long in the render queue" |
| Billing | **charged only when the render succeeds**, exactly once, in the same step that marks the job `completed`. The charge is the **requested video duration** (after normalisation: 2–60 s), not the measured length of the output file. Failed, timed-out, expired and cancelled jobs are never charged. |
| Recovery | a job whose instance crashes is re-queued and rendered by another instance (at most `RENDER_MAX_ATTEMPTS` claims, default 2, then `failed`); a graceful shutdown hands its jobs back to the queue |

### `POST /api/jobs/create` (asynchronous, recommended)
Answers at once: `200 {success, job}` with `job.status = "queued"`. Poll `GET /api/jobs/:id` until `status` is
`completed` (`job.result.downloadUrl`), `failed` (`job.error`) or `cancelled`. Cancel with `POST /api/jobs/:id/cancel`.

### `POST /api/render/video` (synchronous convenience wrapper)
`RENDER_SYNC_WAIT_S` (default **50 s**) is **how long this HTTP request waits** for its job to finish, counting time
spent waiting in the queue and rendering. **It is not an execution timeout**: reaching it never stops the job.

| Outcome | Response |
|---|---|
| refused at admission | `403` / `429` / `402` as above (no job created) |
| job finished within the wait | `200 {success, renderId, jobId, downloadUrl, fileSize, duration, format, aspectRatio, resolution, renderedAt}` (unchanged shape, plus `jobId`) |
| still queued or rendering when the wait ends | `202 {success: true, pending: true, jobId, status, pollUrl: "/api/jobs/<jobId>"}`. The job **keeps running** and is charged only if it completes; the client polls `pollUrl` (owner only) exactly as for `/api/jobs/create`. After a 202 the client may disconnect freely. |
| job failed or timed out within the wait | `500 {error, jobId}`; the job's `error` is in `GET /api/jobs/:id`; not charged |
| **client disconnects before any response** | the server cancels the job (stops its encoder if running); it is not charged. `GET /api/jobs/:id` then shows `cancelled`. |

Keep `RENDER_SYNC_WAIT_S` **below the load balancer's idle timeout**: a connection the proxy cuts looks exactly like
a client that left, and cancels the job. Long renders should use `/api/jobs/create`.

