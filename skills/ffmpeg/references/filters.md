# Allowlisted Filter Graph Reference

`server/media_engine/filterGraph.ts` compiles validated `TimelineSpec` structures exclusively into allowlisted filters:

## Video Filters
- `color`: Base black timeline canvas (`s=WxH:r=FPS:d=DURATION`).
- `trim` / `setpts` / `fps`: Frame-accurate source window slicing and VFR-to-CFR normalization.
- `scale` + `crop` (`fit_mode: "cover"`): Aspect-ratio-preserving center-fill scaling (`setsar=1`).
- `scale` + `pad` (`fit_mode: "contain"`): Letterbox / pillarbox scaling onto black bounds (`setsar=1`).
- `fade`: Luma or alpha (`:alpha=1`) fade-in and fade-out transitions.
- `overlay`: Deterministic time-gated composition (`enable='between(t,START,END)'`).
- `subtitles`: Sanitized SRT rendering with bundled `fontsdir` and escaped paths (`escapeFfmpegFilterPath`).

## Audio Filters
- `atrim` / `asetpts`: Sample-accurate source audio windowing.
- `aresample=44100` / `aformat`: Stereo 44.1 kHz float planar normalization prior to mixing.
- `volume`: Explicit track gain (`0.0` to `4.0`).
- `afade`: Smooth audio track fade-in and fade-out.
- `adelay`: Millisecond timeline offset placement (`adelay=MS|MS`).
- `amix` + `alimiter`: Multi-track stereo mixing (`normalize=0`) with `-0.4 dBFS` true-peak limiter (`limit=0.95`).
- `loudnorm`: EBU R128 broadcast/social loudness normalization (`I=-16:TP=-1.5:LRA=11`).

## QA Diagnostic Filters (`server/media_engine/validator.ts`)
- `blackdetect=d=0.5:pix_th=0.10`
- `freezedetect=n=-50dB:d=2`
- `astats=metadata=1:reset=0`
