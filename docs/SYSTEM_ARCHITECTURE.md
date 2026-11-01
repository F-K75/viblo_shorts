# Forge Studio — System Architecture

> Verified against the running application on 2026-10-31 (not inferred from docs).
> **Important scope note:** Forge Studio is an **AI YouTube Shorts studio** (script → captions → 9:16 video).
> It is *not* a code-generation / multi-agent development platform. There are no workspaces, code editors,
> build pipelines, agent orchestration, teams, or WebSockets in this codebase. Audit items that assume those
> features are reported as "not applicable" in the release report rather than invented.

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 19, Vite 6, Tailwind 4, lucide-react | Single-page app, no router (page state in `App.tsx`) |
| Auth (client) | Firebase Auth (email/password, Google popup) + server-issued guest sessions | `src/utils/api.ts` attaches bearer tokens |
| Backend | Node 22, Express 4, run via `tsx` (TypeScript, no compile step) | Single file `server.ts` + pure modules in `server/lib/` |
| AI | Google Gemini via `@google/genai` 2.24 | Text (JSON schema output) + TTS. Models configurable via env |
| Media | FFmpeg (server render), Canvas + MediaRecorder (client export), Web Audio | |
| Persistence | **PostgreSQL** (production; `server/db/*`, ADR-001…008) or per-user JSON shards (`STORAGE_BACKEND=json`, single instance) behind one `Repo` interface | See docs/ARCHITECTURE_DECISIONS.md |
| External | YouTube oEmbed / InnerTube captions, Pexels video search, Google Drive API (client-side) | All optional; graceful fallbacks |

## Runtime topology

```
Browser (React SPA)
  │  Authorization: Bearer <Firebase ID token | guest token>
  ▼
Express server (server.ts) ─────────────┬── server/lib/auth.ts      (RS256 Firebase verify, HMAC guest tokens)
  │  security headers, request log,     ├── server/lib/security.ts  (SSRF, render-id, range, drawtext escaping)
  │  CORS, JSON body (1 MB), auth gate, ├── server/lib/youtube.ts   (URL/caption parsing, timing estimation)
  │  per-route token-bucket limiter     ├── server/lib/llm.ts       (JSON parse + schema validation)
  │                                     ├── server/lib/repo.ts      (Repo interface; jsonRepo.ts / db/pgRepo.ts)
  │                                     └── server/db/*             (pool, migrations, data migration, off-site backups)
  ├── Gemini API (timeouts, 2 attempts × N models, metrics)
  ├── YouTube oEmbed / captions (timeouts, host allowlist)
  ├── Pexels API (timeout)
  ├── ffmpeg child processes (argument array, no shell; queue, max concurrency, kill on cancel/timeout)
  ├── PostgreSQL: users, projects, subscriptions, jobs (SKIP LOCKED queue), ai_usage_daily, rate_buckets, …
  └── DATA_DIR: renders/*.mp4 (per instance, TTL sweep); JSON backend files when STORAGE_BACKEND=json
```

In development the same process mounts Vite middleware; in production it serves `dist/` statically.
`NODE_ENV=test` serves API only (used by the integration suite).

## Identity & authorization

* The server **never** trusts client-supplied identity (the previous `x-user-id` header and the `admin` magic
  value were removed).
* `Authorization: Bearer` is verified per request:
  * Firebase ID token → RS256 signature against Google securetoken certs (cached per `Cache-Control`),
    `aud`/`iss` = project, `exp`/`iat` with 60 s skew.
  * Guest token → `guest.<payload>.<HMAC-SHA256>` signed with `SESSION_SECRET`, 30-day expiry, random 128-bit id.
* Admins are Firebase UIDs listed in `ADMIN_USER_IDS`.
* All resources (projects, jobs, subscriptions) are keyed by the verified user id; cross-user access returns 404.

## Key flows

See `APPLICATION_FLOW.md`. Exports of the finished Short happen **in the browser** (canvas + MediaRecorder);
the server-side FFmpeg render produces a caption-only 9:16 video (no stock footage or narration compositing).

## Configuration

All configuration is via environment variables — see `.env.example`. Production refuses to start without
`SESSION_SECRET`.
