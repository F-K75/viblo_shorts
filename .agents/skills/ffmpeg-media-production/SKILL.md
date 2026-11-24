---
name: ffmpeg-media-production
description: >
  Professional video and audio processing using FFmpeg and FFprobe inside Forge Studio.
  Use when inspecting media assets, generating multi-track TimelineSpec JSON, building
  allowlisted FFmpeg filter graphs, rendering Reels/Shorts/ads, or evaluating video QA.
---

# FFmpeg Media Production Skill (Forge Studio)

Canonical skill specification and reference library are located at `skills/ffmpeg/SKILL.md`.

Always route media inspection, timeline validation, rendering, and quality evaluation through `server/media_engine/*` and `/api/v1/media/*`:
- `server/media_engine/probe.ts` (`MediaProbe`)
- `server/media_engine/timeline.ts` (`validateTimeline`)
- `server/media_engine/commandBuilder.ts` (`FfmpegCommandBuilder`)
- `server/media_engine/executor.ts` (`FfmpegExecutor`)
- `server/media_engine/validator.ts` (`MediaValidator`)
- `server/agents/media/orchestrator.ts` (`MediaProductionOrchestrator`)

Never construct shell strings or invoke `ffmpeg` with `shell: true`. See `skills/ffmpeg/SKILL.md` for the complete 8-step workflow, failure taxonomy, and output contract.
