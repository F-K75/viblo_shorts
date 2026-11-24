---
name: FMO-001 Repository Discovery
status: complete
owner: orchestrator
updated: 2026-11-25
baseline: a90ba3effc9d9169685fd0c1a86e4c33390fee47
---

# FMO-001 — Forge Media OS Repository Discovery

## Outcome

Forge Media OS extends **Forge Studio**, a Node/Express and React application
for producing vertical Shorts. This audit uses `main` at `a90ba3e`, including
the merged browser footage and quality evaluation changes. The implementation
map and decisions are in [Media OS foundation](FMO_MEDIA_OS_FOUNDATION.md).

## Verified platform map

| Specification integration target | Repository reality | Reuse decision |
| --- | --- | --- |
| FastAPI routes | Express 4 routes in `server.ts` and `server/routes/*` | Add Media OS routes using the existing Express/auth/error conventions. |
| MongoDB persistence | PostgreSQL in production, JSON repository for development/rollback; both implement `Repo` | Add Media OS persistence through an extended repository contract and SQL migrations. Never bypass it with a new datastore. |
| Redis + Celery | `jobs` is a PostgreSQL `SKIP LOCKED` queue with heartbeats and a JSON equivalent. Redis and Celery are absent. | Extend the repository queue with typed jobs and an outbox. |
| State machine | Render jobs have `queued → processing → completed/failed/cancelled` transitions. | Extend the job lifecycle with explicit workflow transitions and evidence. |
| Event bus | Not present. Events are request logs and persisted job polling. | Add a durable, transactional event/outbox contract before agent/workflow orchestration. |
| Dependency resolver / scheduler | No DAG resolver or capability scheduler. The queue only schedules one render job fairly. | Implement Media OS capability resolution and DAG scheduling on top of `Repo` jobs; preserve the existing render admission controls. |
| Agent runtime / tool gateway | Not present. Gemini calls are direct, route-specific code with quota reservation; input validation and auth happen at the Express boundary. | Add a scoped tool gateway and policy decision point before any autonomous agent runtime. |
| FFmpeg/FFprobe media engine | `server.ts` produces a caption-only 9:16 H.264/AAC preview. `server/lib/videoQuality/probe.ts` invokes FFprobe and FFmpeg to measure uploaded browser exports, and `server/routes/quality.ts` can conform the export. | Reuse proven analysis and encoding patterns behind a deterministic provider with bounded execution. |
| Quality intelligence | The browser export flow uses `server/lib/videoQuality/evaluator.ts` and displays results in `QualityReportPanel.tsx`. The legacy evaluator can pass at 80 and the UI offers a manual download after rejection. | Reuse measurement and scoring components under a separate Media OS approval rule with independent evidence and a 90/100 floor. |
| Isolated workers | The application process pumps the queue every two seconds and spawns FFmpeg children. | Move Media OS renders to a separately deployed, locked-down worker before handling uploads or arbitrary source assets. |
| WebSocket streaming | Absent. `GET /api/jobs/:id` exposes owner-scoped status over REST. | Start with REST status and replay. Add live delivery after event persistence. |
| Zustand state | Absent. UI state is React `useState` in `src/App.tsx` and components. | Introduce a focused media workspace store only when the Media Studio foundation is implemented. |

## Existing components that are safe to reuse

| Concern | Verified source | Media OS implication |
| --- | --- | --- |
| Authentication and authorization | `server/lib/auth.ts`, `server/routes/auth.ts` | Reuse verified Firebase/guest identity; protected Media OS operations need explicit scopes/policy on top. |
| Data ownership and migrations | `server/lib/repo.ts`, `server/db/pgRepo.ts`, `server/db/migrations/*` | Add media tables using append-only migrations and preserve owner isolation. |
| Durable render queue | `server.ts`, `server/lib/repo.ts`, `server/db/pgRepo.ts` | Reuse claims, cancellation, heartbeats, retries, expiry and exactly-once render-minute settlement as the execution substrate. |
| Rendering safeguards | `server.ts`, `server/lib/security.ts` | Preserve argument-array spawning, drawtext escaping, bounded inputs, timeout, cancellation and TTL cleanup. |
| AI accounting | `server/lib/llm.ts`, `server/lib/repo.ts` | Reuse durable quota reservations; add provider cost budgets and provenance rather than relying on a model response. |
| Security and operations | `server/lib/requestGuards.ts`, `.github/workflows/ci.yml`, `Dockerfile` | Reuse request limits, readiness checks, container hardening, CI, PostgreSQL migrations and backup mechanisms. |
| Existing studio UX and footage | `src/App.tsx`, `src/components/ShortsPlayer.tsx`, `src/utils/footageStore.ts`, `src/utils/useSourceFootage.ts` | Reuse project, auth, and preview patterns. The attached source stays in the user's browser IndexedDB. Media OS ingestion needs a distinct server-side handoff. |

## Baseline gaps and constraints

1. At the audited commit `main` has no Media OS skill registry, provider interface, capability resolver, workflow timeline contract, artifact service, durable audit event stream, agent runtime, or tool gateway. Its browser export path already has a separate QA engine.
2. The persisted `projects.doc` is an application document. There are no first-class source asset, artifact, asset-version, workflow-run, task-DAG, QA-report, rights, brand-policy or publication-authorization records.
3. The current render queue generates a dark, caption-only preview. The browser can export a clip with attached footage and audio, then upload the exported reel for QA. The two paths do not provide a five-asset workflow, durable artifact versions, or persisted independent QA approval.
4. The current render worker shares the API process and local disk. This is unsuitable for untrusted upload processing or multi-instance artifact delivery. `docs/ARCHITECTURE_DECISIONS.md` already records that rendered MP4 files are per-instance.
5. Direct Gemini calls have validation and accounting, but no media-agent hierarchy, tool policy gateway, provider provenance, prompt lineage, or organizational budget control.
6. The publishing pack generates metadata and captions. It has no external publisher. The pilot delivers an approved version to the internal project library.

## Existing Media Engine prototype

The separate `.worktrees/forge-media-engine` checkout points at `8b6e826`
on `feat/TASK-010-forge-media-engine`. Its index contains staged edits and
unmerged entries in `server.ts`, `server/lib/requestGuards.ts`, and
`tests/billing_recovery.test.ts`. Preserve the checkout and use the committed
prototype as a source for individually reviewed command-building, probe,
timeline, fixture, and UI pieces. The prototype uses transient progress
events and can persist output before queue settlement. Its artifact delivery
and QA approval also need owner-scope and strict-score changes before reuse.
Its workflow test exercises two video clips, so five-clip verification is
still outstanding.

## Mandatory architecture decisions for FMO-003

| Decision | Direction constrained by discovery |
| --- | --- |
| Registry location | Versioned manifests stored in the repository, discovered by a server-side registry service. No manifest is `available` until its contract tests and provider health checks pass. |
| Durable execution | Model Media OS work as typed workflow/task records backed by PostgreSQL and the existing repository interface. Claim work with the existing durable semantics; separate render execution into a worker process. |
| Provider boundary | Provider implementations receive validated, typed inputs and may only use allowlisted binaries/endpoints. FFmpeg/FFprobe is the first deterministic provider. |
| Artifacts | Originals immutable; derived artifacts versioned and addressed through object storage before a multi-instance release. Local disk may be a development-only cache. |
| Events | Use a transactional outbox before consumers/SSE. Do not make autonomous state depend on ephemeral in-process events. |
| Policy | A server-side gateway must authorize every tool/provider call against identity, project ownership, budgets, rights and protected action class. |
| QA | Persist evidence-based technical and creative QA reports independently of planner output. A quality score cannot be self-attested. |

## First vertical-slice design boundary

The first release slice takes five uploaded clips and a creative brief, renders
a vertical video with captions and music, and delivers an internal artifact
only after an independently produced QA report passes the release rule.

The implementation sequence remains FMO-002 through FMO-013, but FMO-004 must define only the minimum schemas needed by that slice. Do not create 231 empty capability directories.

## Evidence collected on 2026-11-25

| Check | Result | Notes |
| --- | --- | --- |
| Repository inventory | Complete | Inspected API/server, repository and migration layers, worker loop, render engine, frontend state, Docker/CI and tests. |
| `npm run lint` | Passed | Frontend and server TypeScript checks passed. |
| `node --import tsx --test tests/footage_store.test.ts tests/pipeline.test.ts tests/auth_llm_storage.test.ts` | Passed on `a90ba3e` | 22 passed, no skips. |
| Current QA suites (`tests/video_quality.test.ts`, `tests/quality_route.test.ts`) | Environment-limited on `a90ba3e` | Running with `/tmp/ffmpeg-bin` on `PATH` and loopback enabled gave 12 passes and 12 failures. The existing FFmpeg 7.1 binary generated fixtures. Ten failures reported `spawn ffprobe ENOENT`. The two positive quality-route cases then had no measured metadata. |
| Earlier `npm test` run | Historical baseline | 185 passed, 15 failed, 17 skipped. FFmpeg was missing from the default `PATH` during this run. The earlier counts do not certify `a90ba3e`. |
| PostgreSQL integration | Not executed locally | `TEST_DATABASE_URL` was not configured; the affected tests self-reported as skipped, not passed. CI provisions PostgreSQL 16. |
| Live Gemini tests | Not executed locally | `GEMINI_API_KEY` was not configured; tests self-reported as skipped. |

## FMO status

| Dimension | Status |
| --- | --- |
| Specified | Yes — Media OS v1.0.0 supplied by product direction. |
| Implemented | The audited commit contains the Forge Studio capabilities above. See the foundation record for the separate Media OS code added after this baseline. |
| Tested | Current typecheck and the 22 focused tests pass. Native FFprobe and the full CI test matrix are required for quality certification. |
| Production-ready | `NOT_READY`. |
