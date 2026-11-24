# Troubleshooting & Automated Repair Playbook

| Error / QA Symptom | Failure Code | Root Cause | Automated / Recommended Repair |
|---|---|---|---|
| `Overlapping video clips require explicit transition` | `TIMELINE_ERROR` | Adjacent clips have `prev.end > next.start` with `transition_out: "none"` | Snap `next.start = prev.end` or set `transition_out: "fade"` + `transition_in: "fade"`. |
| `source_end exceeds source asset duration` | `TIMELINE_ERROR` | AI planned a clip longer than probed `manifest.durationSeconds` | Clamp `source_end` to `manifest.durationSeconds` and adjust clip `end` + downstream starts. |
| Black frames detected (`total_black_duration >= 0.5s`) | `QUALITY_FAILURE` | Unintended timeline gap between sequential clips | Close gaps (`snap_sequential_clips`) so `clip[i].start === clip[i-1].end`. |
| Audio clipping (`Peak level dB > -0.2`) | `QUALITY_FAILURE` | Combined clip + music gain exceeds `0 dBFS` | Reduce music `volume` by 35% and enable `normalize_loudness: true` (`loudnorm`). |
| Unexpected silent output (`RMS <= -75 dB`) | `QUALITY_FAILURE` | Source clips were muted or had `volume: 0` without music/VO | Restore source clip `volume: 1.0` (`mute_source_audio: false`). |
| Frozen video intervals (`total_freeze_duration >= 2s`) | `QUALITY_FAILURE` | Static tail in source clip | Trim clip duration by clamping static tail window. |
| Corrupted / truncated MP4 (`moov atom not found`) | `PROBE_ERROR` | Incomplete upload or invalid media container | Non-recoverable; ask user to re-upload intact source media. |
