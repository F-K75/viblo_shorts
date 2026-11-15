# Backend Health & Architecture Audit

**File:** `engineering/BACKEND_AUDIT.md`  
**Scope:** `server.ts`, `server/lib/*`, `server/db/*`, `package.json`  
**Reference Codebase Commit:** `dffa550` (main branch)

---

## 1. Executive Summary

The Forge Studio backend is implemented in Node.js 22 with Express 4, authored in TypeScript and executed directly via `tsx`. The design prioritizes defensive security, strict user authorization, robust persistence decoupling (PostgreSQL vs JSON shards), and containment of long-running tasks (FFmpeg child processes and Gemini AI calls).

### Top Findings & Observations
1. **[Medium] Large Monolithic Entrypoint:** `server.ts` is ~148KB with over 3,000 lines of code encompassing route definitions, job handlers, and middleware setup. While internally modularized through helper modules, it should be refactored into distinct Express Routers.
2. **[Low] Error Handling & Sanitization:** All responses use structured error handling via `sendError` with HTTP status mapping and stack trace suppression in production.
3. **[Pass] Safe Shell Avoidance:** Child process invocation (`child_process.spawn`) for FFmpeg consistently passes argument arrays without invoking an intermediate shell.
4. **[Pass] Strict User Isolation:** Multi-tenancy isolation is strictly enforced at the database and repository layers; resources are retrieved and mutated exclusively matching `req.user.id`.
5. **[Pass] Dual Backend Compatibility:** The `Repo` contract (`server/lib/repo.ts`) is fully implemented by both `server/lib/jsonRepo.ts` and `server/db/pgRepo.ts`.

---

## 2. Architecture & Module Layout

```
server/
├── db/
│   ├── dataMigration.ts   # JSON to Postgres migration pipeline
│   ├── migrate.ts         # SQL migration runner with advisory locks
│   ├── migrations/        # 001_initial_schema.sql, etc.
│   ├── offsiteBackup.ts   # S3/MinIO age-encrypted streaming pg_dump
│   ├── pgRepo.ts          # PostgreSQL Repo implementation (pg.Pool)
│   └── pool.ts            # Connection pool & healthchecks
├── lib/
│   ├── auth.ts            # Firebase RS256 token verification & Guest HMAC
│   ├── backup.ts          # Local snapshot backup & restore logic
│   ├── guestProtection.ts # Guest project retention limits & cleanup
│   ├── jsonRepo.ts        # Atomic JSON shard Repo implementation
│   ├── llm.ts             # Gemini API client, retries, and schema repairs
│   ├── projectStore.ts    # Project lifecycle and snapshot validation
│   ├── repo.ts            # Repo interface definition & factory
│   ├── requestGuards.ts   # Input limits, rate limiting, and parameter guards
│   ├── security.ts        # SSRF checks, drawtext escapes, security headers
│   ├── storage.ts         # Local render directory cleanup & management
│   ├── usage.ts           # Token/character tracking (ai_usage_daily)
│   └── youtube.ts         # YouTube oEmbed and caption retrieval
└── server.ts              # Express application setup, routes, and lifecycle
```

---

## 3. API Contract & Inventory Alignment

Cross-referenced against `docs/API_INVENTORY.md`:
* **Auth Endpoints:**
  * `POST /api/auth/guest`: Issues signed guest HMAC token (30-day expiry).
  * `GET /api/auth/session`: Validates current Firebase ID or guest token.
* **Project Endpoints:**
  * `GET /api/projects`: Lists user projects.
  * `POST /api/projects`: Creates a project scoped to `req.user.id`.
  * `GET /api/projects/:id`: Retrieves project with ownership check.
  * `PUT /api/projects/:id`: Updates project with optimistic lock / version check.
  * `DELETE /api/projects/:id`: Deletes project scoped to owner.
* **AI & Media Endpoints:**
  * `POST /api/generate-script`: Structured prompt generation with Gemini.
  * `POST /api/youtube/captions`: Fetches captions with strict hostname verification.
  * `POST /api/render`: Enqueues an FFmpeg caption render job.
  * `GET /api/render/:id`: Polls job status; serves rendered MP4 preview.
* **Health & Operations:**
  * `GET /api/health`: Basic liveness probe.
  * `GET /api/ready`: Readiness probe verifying database pool and storage connectivity.
  * `GET /api/health/details`: Detailed metrics (requires `HEALTH_DETAILS_TOKEN`).

---

## 4. Database Interactions & Migrations

* **Engine:** PostgreSQL 14+ (tested against PostgreSQL 16 in CI).
* **Connection Management:** `server/db/pool.ts` configures `pg.Pool` with SSL support (`sslmode=require` in production), keepalives, and connection validation on acquire.
* **Schema Evolution:** `server/db/migrate.ts` executes numbered migrations in transaction blocks guarded by an exclusive PostgreSQL advisory lock (`SELECT pg_advisory_lock(...)`) to prevent multi-instance race conditions during container rolling deployments.
* **Data Safety:** Deletion operations are constrained by foreign keys with cascading or explicit soft-delete flags. Backups are automated via streaming `pg_dump` encrypted with `age`.

---

## 5. Security Evaluation

| Control | Implementation | Severity / Rating |
|---|---|---|
| **SSRF Guard** | `server/lib/security.ts` blocks private IP ranges (RFC 1918, link-local, loopback, IPv6 mapped) before outbound requests. | **Pass (High Confidence)** |
| **Command Injection** | `server.ts` passes FFmpeg flags as `string[]` to `spawn()`; no `exec()` or shell string formatting used. | **Pass (High Confidence)** |
| **Rate Limiting** | Token-bucket limiter per IP and per user ID implemented in `server/lib/requestGuards.ts`. | **Pass** |
| **Guest Claim** | Signed guest HMAC tokens prevent tampering; claims verify token signature before reassigning ownership. | **Pass** |
| **Sensitive Headers** | Express sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, strict CSP, and strips `X-Powered-By`. | **Pass** |

---

## 6. Recommendations

1. **Refactor `server.ts` into Routes:** Decompose into `server/routes/auth.ts`, `server/routes/projects.ts`, `server/routes/render.ts`, and `server/routes/ai.ts`.
2. **Prometheus / OTel Metrics Exporter:** Expand `server/lib/usage.ts` to export standard Prometheus metrics for job latencies and AI token counts.
3. **Database Health Timeout:** Ensure `pool.ts` readiness checks enforce strict 2-second timeouts on acquire to avoid request backpressure when a replica stalls.

