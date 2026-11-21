# Video Quality Audit & Remediation Plan

> **Superseded in part by [REEL_QUALITY_ENGINE.md](REEL_QUALITY_ENGINE.md)**: the reference reel was later inspected
> directly (it is 1080×1920 with digital-zero audio and a 4×-upscaled still); the engine was rebuilt around decoded
> signal, effective detail and visual-state measurements, with a pre-render check and the Excellent/Good/Needs
> improvement/Poor classification. Dimension names below are the previous ones.

Scope: why exported reels can be low quality, and the controls that stop a defective reel from being delivered as a
success. Status markers: **CONFIRMED** = proven from code and/or execution; **HYPOTHESIS** = consistent with the
evidence but not proven.

> **Reference reel not available.** `forge_short_1080p_1795094386694.mp4` was not present in the audit environment
> (searched the whole filesystem). Its file name matches this app's in-browser export
> (`ShortsPlayer.tsx`: ``a.download = `forge_short_${exportResolution}_${Date.now()}` ``), so it was produced by a user's
> browser, not by the server. Statements about that specific file are hypotheses until the file is inspected.

## 1. Architecture discovery

Forge Studio is TypeScript end to end (Express server `server.ts` + `server/`, React/Vite client `src/`). There is no
Python, no WebSocket channel (server jobs are polled over REST) and no AI image/video generation.

| Stage | Module(s) | Notes |
|---|---|---|
| Entry points | `src/App.tsx` `handleGenerateFromPrompt` (idea), `handleAnalyzeYouTubeUrl` (YouTube), local-video flow | Three creation modes |
| Script generation | `POST /api/generate-script` (`server.ts`), `server/lib/llm.ts` (`validateScript`) | Gemini when configured, else labelled template |
| Clip selection | `POST /api/youtube/generate-clips`, `POST /api/clips/from-transcript`; `server/lib/youtube.ts` `pickTranscriptClips` | AI ranking or transcript heuristics |
| Script segmentation | beats (`Beat` in `src/types.ts`): one sentence-ish unit each | No narrative role field |
| Scene planning | none as a separate step: one beat = one scene | |
| Media search/selection | `App.tsx` per beat → `POST /api/stock-footage` (Pexels or 16-item `FALLBACK_VERTICAL_VIDEOS`), client `utils/visualPlaceholders.ts` | takes `results[0]` |
| Source footage | `ShortsPlayer.tsx` source file / `server/routes/youtubeDownload.ts` / `utils/footageStore.ts` | user's own video |
| Voice | `POST /api/tts` (Gemini TTS) ← `utils/audio.ts` `speakNeuralOrFallback` | browser speechSynthesis fallback is not recordable |
| Music | `utils/audio.ts` Web Audio synth | |
| Word timestamps | `utils/pipeline.ts` `estimateWordTimings`, `recalculateWordsFromBeats` | **estimated**, never measured from audio |
| Captions | `utils/pipeline.ts` `chunkWords` → `utils/exportCanvas.ts` `drawCaptionChunk` | fixed N-word chunks |
| Composition + effects | `ShortsPlayer.tsx` `handleExportVideo` (canvas 2D, real time), `exportCanvas.ts`, `utils/smartCrop.ts` | hard cuts only |
| Encode / export | browser `MediaRecorder` on `canvas.captureStream(0)` + Web Audio track | codec chosen by browser support |
| Server render (unused by UI) | `POST /api/render/video`, job queue `/api/jobs/*` (ffmpeg drawtext on colour) | API only |
| Storage | projects: JSON/PostgreSQL repo; media: browser blob URLs + IndexedDB; server renders in `data/renders` | |
| Error handling | per-route try/catch, labelled AI fallbacks; export errors shown in the player | **no post-export validation** |

### Pipeline (as found)

```
User request ─┬─ idea ──► /api/generate-script ─► beats ─► estimateWordTimings ─► per-beat /api/stock-footage (results[0])
              ├─ YouTube ► /api/youtube/generate-clips ─┐
              └─ local ──► /api/clips/from-transcript ───┴► clip beats (verbatim transcript) ─► user's source file
                                                                     │
        recalculateWordsFromBeats (estimated word times) ◄───────────┘
                         │
                 chunkWords(wordsPerChunk = 2)
                         │
  ShortsPlayer.handleExportVideo: real-time canvas draw (footage / B-roll / motion bg + captions)
     + Web Audio (music, source audio, TTS fetched *when each beat starts*)
                         │
                  MediaRecorder ─► Blob ─► <a download="forge_short_${exportResolution}_…">   ◄── no inspection
```

## 2. Root-cause analysis

### D. Export / resolution (symptom 6)
- **CONFIRMED — the label is the requested setting, not the output.** `ShortsPlayer.tsx` names the file from the
  `exportResolution` state ("1080p") and never inspects the recorded file. Nothing anywhere reads the actual
  dimensions, codec, pixel format, frame rate or audio of an export.
- **CONFIRMED — the canvas itself is 1080×1920** (`canvasW/H` from `exportResolution`). In this environment
  (Chromium, Linux, software H.264) recordings come out at exactly 1080×1920 (ffprobe), so a 512×910 file was
  re-scaled by the *browser's encoder*, not by our drawing code.
- **HYPOTHESIS — encoder-side downscale.** Browser MediaRecorder implementations may adapt resolution (hardware
  encoders, low-power devices, background-tab throttling, Safari). 512×910 is exactly 0.474× of 1080×1920 on both axes,
  consistent with an encoder scale-down rather than a cropping or layout bug. Needs the file's metadata to confirm.
- **CONFIRMED — MediaRecorder output is not a delivery format**: fragmented MP4 (no `faststart`), variable frame
  timing, codec dependent on the browser (WebM/VP9 on some), audio sometimes Opus. No conform step exists.

### A. Captions (symptoms 2, 3)
- **CONFIRMED — fragments by design.** Default style (`App.tsx`, several presets) has `wordsPerChunk: 2`;
  `chunkWords` emits at most 2 words per caption. A sentence is shown as 2-word flashes ("WHY DOES" · "YOUR TO-DO" …).
  Earlier fix stops chunks crossing sentence ends, but phrases are still split arbitrarily.
- **CONFIRMED — timestamps are estimates.** `recalculateWordsFromBeats` distributes each beat's duration by word length.
  Captions come from the script/transcript text, not from transcribing the produced audio; there is no forced alignment.
- **CONFIRMED (code) — narration/caption desync and truncated speech.** With AI voice on, `handleExportVideo` calls
  `speakNeuralOrFallback` *when a beat starts*: the TTS request then takes a network round-trip (narration starts late),
  and the next beat's `stopSpeech()` cuts the previous line off mid-sentence if it runs longer than the estimate. Words
  are lost from the audio while the captions keep running on estimated time. (Not executable here: no Gemini key.)
- **CONFIRMED — punctuation is stripped** in rendering (`formatWord` removes `.,!?;:`); readable, but sentence ends are
  invisible.
- **CONFIRMED — no caption validation** (coverage, overlap, orphan, overflow, duration vs audio).
- Words are not dropped by rendering: `drawCaptionChunk` wraps lines without omitting words (verified by tests).

### B. Visual repetition (symptoms 1, 5)
- **CONFIRMED — idea flow selects `results[0]` per beat with no de-duplication.** Similar `visual_keywords` (common in
  LLM and template scripts) return the same first result → the same clip repeats. Without `PEXELS_API_KEY` the server
  falls back to a 16-item list scored by keyword overlap; beats on one topic all map to the same best match.
- **CONFIRMED — when stock media fails to load** (CORS/offline), every beat falls back to the motion background (one
  look for the whole reel, varying only in colour).
- **CONFIRMED — source-footage clips are one continuous shot.** A 28 s talking-head clip is a single static framing
  for its whole length: no punch-ins, no cut-aways, no B-roll inserts.
- **HYPOTHESIS — the reference reel** ("same speaker footage for an excessive duration", 28.44 s) is a talking-head clip
  from the source-footage path.

### C. Storytelling (symptoms 4, 7)
- **CONFIRMED — no narrative structure is represented.** Beats have no role (hook/context/…), no per-scene visual
  description beyond keywords, no transition field; transitions are always hard cuts; nothing checks that visuals
  relate to the spoken words.

## 3. Issue register (severity ranked)

| ID | Sev | Issue | Status |
|---|---|---|---|
| Q-01 | P0 | Exports labelled "1080p" without inspection; actual dimensions/codec never validated | CONFIRMED |
| Q-02 | P0 | No post-export quality evaluation or gate: any MediaRecorder output is delivered as success | CONFIRMED |
| Q-03 | P0 | AI narration fetched late and cut off between beats; captions not aligned to real speech | CONFIRMED (code) |
| Q-04 | P1 | Captions shown as 2-word fragments; no phrase grouping; no caption validation | CONFIRMED |
| Q-05 | P1 | Same stock clip repeats across beats (`results[0]`, no de-dup) | CONFIRMED |
| Q-06 | P1 | MediaRecorder output not conformed (fragmented MP4, VFR, codec varies) | CONFIRMED |
| Q-07 | P1 | Encoder-side downscale to 512×910 | HYPOTHESIS |
| Q-08 | P2 | No narrative roles / scene plan; single static framing for talking-head clips | CONFIRMED |
| Q-09 | P2 | Word timings estimated, not forced-aligned to audio | CONFIRMED (needs STT/alignment) |

## 4. Implementation plan (smallest safe sequence)

1. **Evaluation engine (server, no new deps)** — `server/lib/videoQuality/`: ffprobe + ffmpeg analysis filters,
   7 weighted dimensions, evidence per check, configurable thresholds, PASS / NEEDS_IMPROVEMENT / REJECTED gate with
   critical defects. Unit-tested with synthetic defective fixtures (512×910, silent, black, frozen, duplicate shots,
   broken captions).
2. **Export pipeline integration** — after MediaRecorder: upload the *exported reel* (never the source footage) →
   ffprobe → conform to the delivery spec (H.264 High, yuv420p, CFR, AAC, faststart) **without upscaling**; evaluate;
   remediate (one bounded re-record with another encoder when the recorded size is wrong); deliver with the measured
   spec in the file name; show score, dimensions, status, problems, suggestions, remediation in the export panel.
3. **Captions** — phrase-based grouping (sentence/clause aware, max chars per line, max 2 lines, no orphan words),
   caption validation in the evaluator.
4. **Visual variety** — per-beat de-duplicated asset selection; repeated-asset detection in the evaluator; punch-in
   framing changes at sentence boundaries for single-shot source clips.
5. **Narration** — pre-fetch all TTS before recording, re-time beats and captions to the real audio durations,
   schedule lines on the audio clock so they never overlap or cut off.
6. **Narrative roles** — optional `role` per beat (hook / context / main / progression / cta), inferred when absent,
   evaluated for coverage.

## 5. Evaluation architecture

```
server/lib/videoQuality/
  thresholds.ts   configurable weights, limits, gate thresholds (env overridable)
  models.ts       types: Check, DimensionResult, Evaluation, Timeline input
  probe.ts        ffprobe + ffmpeg filter runners (argument arrays, timeouts) → MediaFacts
  similarity.ts   perceptual hashes of shot frames, duplicate-shot clustering
  exportQuality.ts    dimensions, codec, pix_fmt, fps, audio codec, faststart, duration
  visualQuality.ts    blur, black frames, frozen/duplicate frames, render resolution
  audioQuality.ts     presence, loudness, clipping, silence, A/V alignment, speech/music balance
  captionQuality.ts   coverage vs script, overlaps, orphans, line overflow, timing vs duration
  sceneQuality.ts     shot count/variety, repetition, durations, roles, relevance
  evaluator.ts        runs dimensions, weights, gate, suggestions
server/routes/quality.ts  upload → conform → evaluate → download (owner-only, TTL, caps)
```

Model-based judgement (e.g. "is this emotionally compelling") is **not** attempted: storytelling is scored only from
measurable proxies (role coverage, keyword relevance, pacing), and the report says so.

## 6. Implementation results

### Pipeline (after)

```
request → script / clip selection → scene media (de-duplicated per scene) → narration pre-fetched & beats re-timed to it
→ phrase captions (renderer-measured, ≤ 2 lines) → canvas composition (auto-framing, punch-ins) → MediaRecorder
→ upload exported reel → probe → conform (H.264 High / yuv420p / CFR 30 / AAC 48 kHz / -14 LUFS / faststart, no upscaling)
→ evaluate (7 dimensions, evidence) → gate → re-record at most once if the recording itself is broken
→ deliver the verified file named by its MEASURED size, or hold a REJECTED reel behind "Download anyway"
```

### Root causes confirmed → fixes

| ID | Root cause (confirmed) | Fix | Evidence |
|---|---|---|---|
| Q-01 | File named from the setting, never inspected | Name from ffprobe (`forge_short_<W>x<H>_…`); report shows requested vs actual | `quality.e2e` regression: 512×910 recording → `forge_short_512x910_…`, REJECTED |
| Q-02 | No post-export validation | `server/lib/videoQuality/*` + `server/routes/quality.ts` + export orchestration in `ShortsPlayer.tsx` | 20 unit/integration tests, 2 browser tests |
| Q-03 | TTS fetched at beat start, cut off by the next beat | `audioManager.prefetchTts` + `retimeBeatsToNarration` when AI voice is enabled | unit test (re-timing); live TTS not executable here (no key) |
| Q-04 | `wordsPerChunk: 2` fragments | `chunkCaptionPhrases` with the renderer's own line layout (`captionLineCount`); "Phrases" default, word bursts opt-in | unit tests; overflow went 11 → 0 on a real export |
| Q-05 | `results[0]` per beat | `pickDistinctAssets` per scene; repeated stills replaced by per-scene motion | unit test; still-image reel 28.7 s single shot → split |
| Q-06 | MediaRecorder output not a delivery format | server conform | route test: WebM/VP9/Opus → H.264/AAC/yuv420p/faststart |
| Q-08 | One static framing for a talking head | punch-ins on alternate sentences (toggle) + auto-framing | frames show the framing change |

Q-07 (why a browser recorded 512×910) remains a **hypothesis**: it cannot be reproduced in Chromium/Linux, which
records 1080×1920. The system no longer depends on it: whatever the encoder does, the result is measured, a broken
recording is re-recorded once with another encoder, and a reel that still misses the spec is rejected and named by its
real size. **Upscaling is never used to "fix" it.**

### Before / after (same 28.7 s talking-head clip, real app export, evaluated by the engine)

The reference reel itself was not available, so a comparable reel was produced twice through the real UI from the
test talk (`tests/fixtures/talk.transcript.txt` + a 1920×1080 source). "Before" = previous defaults (2-word captions,
centre crop, no punch-ins); "after" = new defaults.

| | Before | After |
|---|---|---|
| Status | **NEEDS_IMPROVEMENT** | **PASS** |
| Score | 86.8 | 99 |
| Captions | 13/20 — 80% of captions are 1–2 word fragments | 20/20 |
| Scene diversity | 9.8/15 — one source shot unchanged for 28.7 s | 15/15 |
| Editing & pacing | 9/10 | 9/10 (scene-cut detector does not count punch-ins as cuts: reported, minor) |
| Export | 10/10 (1080×1920 after conform) | 10/10 |

Reference-reel symptoms reproduced and verified by tests: a 512×910 recording of a 1080×1920 export is REJECTED with a
critical `dimensions` defect, re-recorded exactly once, not downloaded automatically, and named `512x910`
(`tests/e2e/quality.e2e.test.ts`, `tests/quality_route.test.ts`, `tests/video_quality.test.ts`).

### Remaining limitations
- Word timings are still estimates (no forced alignment / speech-to-text). Sync is checked against measured speech
  onset and silences, not word by word.
- Storytelling is scored from proxies; emotional impact is not judged (no model-based evaluation is used).
- Speech/music balance is checked from the configured mix (stems are not separable after export).
- Distinct-frame rate depends on the user's machine; low values are reported (minor), not fixed.
- Evaluation uploads the exported reel to the server (deleted after `QUALITY_TTL_MIN`); source footage is never sent.
- AI voice re-timing, Gemini scripts and real Pexels footage could not be run here (no keys / blocked hosts).

### Production readiness
The gate is deterministic, bounded (1 re-record, size/time/concurrency caps, TTL) and costs no AI calls. Ready for
staging with real browsers (Chrome/Edge/Safari on Mac/Windows/Android) to confirm Q-07 and calibrate thresholds on real
exports before enforcing REJECTED as blocking for all users.
