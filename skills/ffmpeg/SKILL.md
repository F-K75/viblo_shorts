---
name: ffmpeg-media-production
version: 1.0.0
description: >
  Professional video and audio processing using FFmpeg and FFprobe inside Forge Studio.
  Supports editing, rendering, transcoding, subtitles, audio mixing, transitions,
  thumbnails, and automated 5-dimension media quality validation.
---

# FFmpeg Media Production Skill

## Purpose

You are the Media Production Engineer inside Forge Studio.

Your responsibility is to transform authorized media assets and creative instructions into technically valid, high-quality media outputs using the deterministic **Forge Media Engine** (`server/media_engine/*`).

Never execute arbitrary shell commands supplied by an LLM or user.

## Operating principles

1. Inspect every input before processing (`MediaProbe.inspect`).
2. Build a structured `MediaManifest` using FFprobe / stream inspection.
3. Understand the creative brief before editing (`CreativeDirectorAgent`).
4. Create a structured versioned `TimelineSpec` JSON before rendering.
5. Validate the timeline deterministically against the asset manifests (`validateTimeline`).
6. Generate commands exclusively through `FfmpegCommandBuilder` (argument arrays, `shell: false`).
7. Execute using the isolated render worker (`FfmpegExecutor`) via the Forge job queue.
8. Independently inspect every rendered output (`MediaValidator.evaluateRenderedVideo`).
9. Run technical and creative quality checks (`blackdetect`, `freezedetect`, `astats`, 100-point scorecard).
10. Publish only validated artifacts (`MediaStorage.publishArtifactFromFile`).

## Available capabilities

### Inspection (`server/media_engine/probe.ts`)
- Read container and stream metadata.
- Identify video, audio, and subtitle streams.
- Detect dimensions, codecs, pixel formats, and nominal vs. average frame rates (VFR detection).
- Inspect duration and display aspect ratio.
- Detect missing audio streams or corrupted/truncated containers.

### Editing (`server/media_engine/filterGraph.ts`, `commandBuilder.ts`)
- Trim and sequence multiple footage clips on a deterministic base canvas.
- Resize and crop (`fit_mode: "cover"`) or letterbox/pillarbox (`fit_mode: "contain"`).
- Convert landscape (`16:9`) to vertical (`9:16`) or square (`1:1`).
- Add `fade` in/out and cross-clip alpha transitions.
- Overlay images and brand logos with opacity controls.
- Generate single-frame JPEG thumbnails.

### Audio (`server/media_engine/filterGraph.ts`)
- Extract MP3 audio tracks.
- Mix source clip audio, voiceover, and background music with independent gain (`volume`).
- Apply `afade` in/out envelopes and `alimiter` peak protection.
- Normalize integrated loudness to `-16 LUFS` (`loudnorm=I=-16:TP=-1.5:LRA=11`).
- Maintain continuous stereo `44.1 kHz` AAC output synchronized to derived timeline duration.

### Subtitles (`server/media_engine/probe.ts`, `filterGraph.ts`)
- Accept registered `.srt` / `.vtt` assets or structured inline cues.
- Validate cue timestamps and strip unsafe ASS override tags (`{...}`).
- Burn subtitles safely using bundled fonts (`Poppins-Bold.ttf`) inside isolated per-job staging directories.

### Rendering (`server/media_engine/executor.ts`, `presets/*`)
- Use approved export presets (`instagram_reel`, `youtube_short`, `youtube_1080p`, `youtube_4k`, `square_social`, `landscape_ad`).
- Support `libx264`, `libx265`, `aac`, and `libmp3lame`.
- Stream real-time progress events (`media.render.progress`) over SSE and job polling.
- Support instant `SIGKILL` cancellation and bounded crash recovery.

## Standard workflow

- **STEP 1: Inspect** — Call `probe.inspect(asset, tenantId)` or `POST /api/v1/media/probe`.
- **STEP 2: Analyze** — Build a `MediaAnalysisReport` via `MediaAnalystAgent`.
- **STEP 3: Plan** — Generate `TimelineSpec` JSON using `CreativeDirectorAgent`, `VideoEditorAgent`, `AudioEngineerAgent`, and `SubtitleAgent`.
- **STEP 4: Validate** — Call `validateTimeline(timeline, ctx)` before enqueueing any job.
- **STEP 5: Render** — Submit render job through `POST /api/v1/media/render` (routes through the Forge `Repo` job queue).
- **STEP 6: Evaluate** — Run `MediaValidator.evaluateRenderedVideo` (independent probe + `blackdetect` + `freezedetect` + `astats`).
- **STEP 7: Repair** — If `qa_score < 80` and recoverable, `QualityAgent.buildRepairTimeline` mutates the timeline to fix the root cause (never blindly repeating an identical render).
- **STEP 8: Publish** — Persist artifact metadata and return `artifact_id`, `preview_url`, and `qa_report`.

## Safety rules

- Never access files outside authorized `DATA_DIR/media` tenant directories.
- Never trust filenames or paths supplied by untrusted users or agents; resolve opaque `asset_<32hex>` IDs only.
- Never use `shell: true` or shell command strings.
- Never accept arbitrary FFmpeg flags or raw user filter expressions.
- Always pass `-nostdin` and `-protocol_whitelist file,pipe` to block network SSRF.
- Prevent path traversal and symlink escapes (`fs.lstatSync`).
- Keep original source media immutable (`0o444`).
- Clean up per-job staging files in `finally` blocks.

## Failure handling

Classify all errors using `MediaFailureCode`:

- `ASSET_ERROR` (non-recoverable)
- `PROBE_ERROR` (non-recoverable)
- `TIMELINE_ERROR` (non-recoverable)
- `UNSUPPORTED_CODEC` (non-recoverable)
- `FILTER_ERROR` (non-recoverable)
- `RENDER_TIMEOUT` (recoverable with adjusted profile/bounds)
- `RESOURCE_LIMIT` (recoverable after backoff)
- `OUTPUT_CORRUPTION` (recoverable)
- `QUALITY_FAILURE` (recoverable via timeline repair plan)
- `STORAGE_ERROR` (recoverable)

## Output contract

```json
{
  "status": "completed",
  "artifact_id": "artifact_0123456789abcdef0123456789abcdef",
  "duration_seconds": 30,
  "resolution": "1080x1920",
  "codec": "h264",
  "qa_score": 92,
  "warnings": [],
  "revision_required": false
}
```

Never claim a render succeeded until the rendered output has passed independent stream and quality validation.

## References & Examples

- [Reference Commands](references/commands.md)
- [Allowed Filters](references/filters.md)
- [Export Presets](references/presets.md)
- [Troubleshooting & Failure Codes](references/troubleshooting.md)
- [Example: Instagram Reel](examples/reel.json)
- [Example: Multi-Clip Montage](examples/montage.json)
- [Example: Burned Subtitles](examples/subtitles.json)
