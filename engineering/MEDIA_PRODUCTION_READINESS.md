# Forge Media Engine v1.0 — Production Readiness Report

**Branch / Worktree:** `feat/TASK-010-forge-media-engine` (`.worktrees/forge-media-engine`)  
**Target:** Forge Studio (`viblo_shorts` v1.0.0)  
**Date:** 2026-11-25

---

## 1. Implemented Capabilities

1. **Core Media Engine (`server/media_engine/*`):**
   - `config.ts`, `exceptions.ts`, `models.ts`: Strict failure classification (`ASSET_ERROR`, `PROBE_ERROR`, `TIMELINE_ERROR`, `UNSUPPORTED_CODEC`, `FILTER_ERROR`, `RENDER_TIMEOUT`, `RESOURCE_LIMIT`, `OUTPUT_CORRUPTION`, `QUALITY_FAILURE`, `STORAGE_ERROR`), codec/container/protocol allowlists (`-protocol_whitelist file,pipe`), and runtime schema validation.
   - `storage.ts`: Tenant-isolated SHA-256 directory partitioning, immutable `0o444` source media storage, symlink/path-traversal protection (`lstatSync` + `realpathSync`), per-job staging cleanup, and optional S3 object storage (`@aws-sdk/client-s3`).
   - `probe.ts`: FFprobe JSON stream inspection + deterministic FFmpeg stream-header & `showinfo` VFR fallback + `0.5s` decode sanity check + SRT/WebVTT cue parser.
   - `presets/*`: All 6 export profiles (`instagram_reel`, `youtube_short`, `youtube_1080p`, `youtube_4k`, `square_social`, `landscape_ad`).
   - `timeline.ts`, `filterGraph.ts`, `commandBuilder.ts`: Authoritative duration derivation, transition overlap rules, multi-clip `scale`/`crop`/`pad`/`fade`/`overlay` composition, multi-track `amix`/`afade`/`alimiter`/`loudnorm` (`-16 LUFS`), safe SRT subtitle burn-in with bundled `Poppins-Bold.ttf`, and all 8 Section 6 atomic FFmpeg commands.
   - `executor.ts`, `progress.ts`: Zero-shell `spawn` execution with scrubbed child `env`, real-time stderr progress parsing, `SIGKILL` cancellation, SSE live streaming, and JSONL audit logs.
   - `validator.ts`: Independent post-render stream probe + parallel `blackdetect`, `freezedetect`, and `astats` checks producing a 5-dimension 100-point QA scorecard.
2. **Persistence & Queue Integration (`server/media_engine/mediaStore.ts`, `0007_media_engine.sql`, `server/routes/media.ts`, `server.ts`):**
   - Full dual-backend parity (`JsonMediaMetadataStore` + `PostgresMediaMetadataStore`).
   - `/api/v1/media/{presets,assets,probe,projects,render,jobs,artifacts}` + SSE `/api/v1/media/jobs/:id/events` + HTTP `206` Range downloads + `Idempotency-Key` deduplication.
   - Preserves single-worker render queue invariant (`S1`) and atomic render-minute billing (`repo.completeJob`).
3. **FFmpeg Agent Skill & Specialist Agents (`skills/ffmpeg/*`, `server/agents/media/*`):**
   - `SKILL.md` (mirrored to `.agents/skills/ffmpeg-media-production/SKILL.md`), 4 reference docs, and 3 canonical timeline JSON examples.
   - 7 specialist agents (`MediaAnalystAgent`, `CreativeDirectorAgent`, `VideoEditorAgent`, `AudioEngineerAgent`, `SubtitleAgent`, `RenderAgent`, `QualityAgent`) coordinated by `MediaProductionOrchestrator` with capability-only separation for `CreativeDirectorAgent` and single-pass automated QA repair.
4. **Frontend Workspace (`src/components/MediaStudioWorkspace.tsx`, `src/App.tsx`):**
   - Drag-and-drop asset upload + FFprobe metadata cards, multi-track timeline lanes (`VIDEO 1`, `AUDIO`, `SUBTITLES`), live progress & cancellation, MP4 preview player, and 5-dimension QA scorecard.

---

## 2. Known Limitations & Host Observations

1. **Host `ffprobe` & PostgreSQL Services:** Standalone `ffprobe`, `docker`, and local `postgres` are not installed on this macOS development host. `MediaProbe` automatically uses its `ffmpeg` 7.1 stream-header + `showinfo` inspector locally and switches to `ffprobe -of json` inside the production container (`Dockerfile` installs both `ffmpeg` and `ffprobe`). PostgreSQL contract tests remain skipped locally when `TEST_DATABASE_URL` is unset (per `README.md`), and run in CI where `REQUIRE_PG_TESTS=1`.
2. **Multi-Instance Shared Media Files:** When running multiple server replicas, set `MEDIA_S3_BUCKET` so uploaded assets and published artifacts are shared across instances via S3 rather than instance-local `DATA_DIR/media`.
3. **Vision-Model Subjective Scoring:** Automated QA currently executes deterministic FFmpeg `blackdetect`, `freezedetect`, `astats`, stream geometry, and timeline continuity scoring; optional Gemini Vision frame sampling can be layered onto `QualityAgent` when live `GEMINI_API_KEY` quota is provisioned (`TASK-002`).

---

## 3. Gate Status & Release Recommendation

- **Gate 0–2:** Approved by CTO.
- **Gate 3 (Build, Lint & Golden Media Suite):** Verified with real FFmpeg 7.1 execution.
- **Gate 4 (Independent & Security Review):** Pending `independent-reviewer` & `security-engineer` subagent sign-off.
- **Gate 5 (Merge to `main`):** Requires explicit CTO approval per `.agents/rules/approval-gates.md`.
