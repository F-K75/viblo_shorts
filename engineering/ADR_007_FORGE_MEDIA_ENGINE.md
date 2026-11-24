# ADR-007: Native Forge Media Engine & Deterministic FFmpeg Boundary

- **Status:** Accepted (G0–G2 Approved)
- **Date:** 2026-11-25
- **Context:** Forge Studio required upgrading from synthetic client/server caption previews to a full multi-track FFmpeg media production capability with specialist AI agents, versioned timeline validation, 6 social/broadcast export presets, and automated 5-dimension quality evaluation.

## Decision

1. **Strict AI / Deterministic Execution Boundary:** AI specialist agents (`CreativeDirectorAgent`, `VideoEditorAgent`, `AudioEngineerAgent`, `SubtitleAgent`) output structured JSON (`EditPlan`, `TimelineSpec`) only. They never construct shell strings or FFmpeg flags. `FfmpegCommandBuilder` and `filterGraph.ts` deterministically compile validated `TimelineSpec` instances into argument arrays executed via `child_process.spawn(..., { shell: false })`.
2. **Reuse Native Forge Stack (DEC-001 Alignment):** Rather than introducing a second Python/FastAPI + Celery + Redis + MongoDB stack, the Media Production Engine is implemented natively in TypeScript (`server/media_engine/*`, `server/agents/media/*`, `server/routes/media.ts`) on top of Forge Studio's existing Express 4 runtime, dual `Repo` persistence (`PostgresRepo` `FOR UPDATE SKIP LOCKED` + `JsonRepo` parity), `@aws-sdk/client-s3`, and SSE event streaming.
3. **Single Render Queue Invariant (`S1`):** Every `/api/v1/media/render` job enters `repo.insertJob` as `media_render` and is executed exclusively by `executeRenderJob` in `server.ts`, preserving per-user/global admission caps, fair scheduling, heartbeats, crash reaping, `SIGKILL` cancellation, and atomic render-minute billing (`repo.completeJob`).
4. **Independent Post-Render QA & Single-Pass Repair:** A zero exit code from FFmpeg is never sufficient to publish an artifact. `MediaValidator` runs independent stream probing plus `blackdetect`, `freezedetect`, and `astats` to compute a 100-point scorecard; recoverable scores below `80` enter one deterministic `QualityAgent.buildRepairTimeline` pass before artifact publication.

## Consequences

- Zero new runtime infrastructure services or npm dependencies required in production.
- Full backward compatibility with existing `/api/render/video`, `/api/jobs/*`, and PostgreSQL rolling deployments (`0007_media_engine.sql` marked `-- forge:backward-compatible`).
