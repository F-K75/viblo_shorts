# Export Presets Reference

Defined in `server/media_engine/presets/*`:

| Preset ID | Name | Aspect | Resolution | FPS | Default Video Codec | Audio Codec | Max Duration |
|---|---|---|---|---|---|---|---|
| `instagram_reel` | Instagram Reel | 9:16 | 1080×1920 | 30 | `libx264` | `aac` (192k) | 90s |
| `youtube_short` | YouTube Short | 9:16 | 1080×1920 | 30 | `libx264` | `aac` (192k) | 180s |
| `youtube_1080p` | YouTube 1080p | 16:9 | 1920×1080 | 30 | `libx264` | `aac` (192k) | 900s |
| `youtube_4k` | YouTube 4K | 16:9 | 3840×2160 | 30 | `libx265` / `libx264` | `aac` (256k) | 900s |
| `square_social` | Square Social | 1:1 | 1080×1080 | 30 | `libx264` | `aac` (192k) | 120s |
| `landscape_ad` | Landscape Ad | 16:9 | 1920×1080 | 30 | `libx264` | `aac` (192k) | 180s |

All presets enforce `yuv420p` pixel format and `+faststart` MP4 atom placement for universal browser and mobile playback.
