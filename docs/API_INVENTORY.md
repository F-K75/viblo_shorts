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
