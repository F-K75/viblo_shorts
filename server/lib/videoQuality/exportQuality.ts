import { check, round, unmeasured } from './checks.ts';
import type { Check, ExportSpecReport, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';

/**
 * Video and export quality (Weight: 15).
 * Validates real probed container/stream metadata against the 9:16 vertical export standard:
 *  - Resolution (e.g. 1080×1920), Aspect ratio (9:16), Frame rate (CFR), H.264, yuv420p, AAC, faststart, duration.
 */
export function evaluateExport(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): { checks: Check[]; spec: ExportSpecReport } {
  const spec = { ...th.spec, ...(timeline?.target || {}) };
  const requested = { width: spec.width, height: spec.height, fps: spec.fps, videoCodec: th.spec.videoCodec, pixFmt: th.spec.pixFmt, audioCodec: th.spec.audioCodec };
  const checks: Check[] = [];

  if (!media) {
    return {
      checks: [check('export', 'file_readable', false, 'critical', 'Exported file is missing, empty, or corrupted and cannot be read by ffprobe.', {}, 'Re-export the video and verify encoder output.')],
      spec: { requested, actual: null, meetsSpec: false, label: 'corrupted' },
    };
  }

  const v = media.video;
  if (!v || v.width <= 0 || v.height <= 0) {
    checks.push(check('export', 'video_stream', false, 'critical', 'The exported file has no valid video stream.', { container: media.container }, 'Re-export the video; the video encoder produced no track.'));
    return { checks, spec: { requested, actual: null, meetsSpec: false, label: 'no-video' } };
  }

  const dimsOk = v.width === spec.width && v.height === spec.height;
  checks.push(
    check(
      'export',
      'dimensions',
      dimsOk,
      'critical',
      dimsOk
        ? `Export resolution ${v.width}×${v.height} matches the target ${spec.width}×${spec.height}.`
        : `Invalid resolution: exported ${v.width}×${v.height}, but ${spec.width}×${spec.height} is required.`,
      { actual: `${v.width}x${v.height}`, requested: `${spec.width}x${spec.height}`, width: v.width, height: v.height },
      'Re-render at the target 1080×1920 resolution with the tab in the foreground (never upscale a downscaled recording).',
    ),
  );

  const aspect = v.width / v.height;
  const ratioOk = Math.abs(aspect - 9 / 16) < 0.015;
  checks.push(
    check(
      'export',
      'aspect_ratio',
      ratioOk,
      'major',
      ratioOk ? 'Aspect ratio is 9:16 vertical.' : `Aspect ratio is ${round(aspect, 3)}, not 9:16 (0.5625).`,
      { width: v.width, height: v.height, aspectRatio: round(aspect, 4), expected: 0.5625 },
      'Configure vertical 9:16 export canvas (1080×1920).',
    ),
  );

  checks.push(
    check(
      'export',
      'video_codec',
      v.codec === th.spec.videoCodec,
      'major',
      `Video codec: ${v.codec.toUpperCase()} (target H264).`,
      { codec: v.codec, profile: v.profile },
      'Conform export to H.264 (libx264) for universal social-platform playback.',
    ),
  );

  checks.push(
    check(
      'export',
      'pixel_format',
      v.pixFmt === th.spec.pixFmt,
      'major',
      `Pixel format: ${v.pixFmt} (target ${th.spec.pixFmt}).`,
      { pixFmt: v.pixFmt },
      'Re-encode to yuv420p for iOS, Android, Shorts, Reels, and TikTok compatibility.',
    ),
  );

  const fpsOk = Math.abs(v.fps - spec.fps) <= th.spec.fpsTolerance;
  checks.push(
    check(
      'export',
      'frame_rate',
      fpsOk,
      'major',
      `Frame rate: ${v.fps} fps (target ${spec.fps} fps CFR).`,
      { fps: v.fps, frames: v.frames, target: spec.fps },
      'Conform export to constant frame rate (CFR).',
    ),
  );

  const audioRequired = timeline?.audio.required ?? true;
  if (audioRequired || media.audio) {
    const a = media.audio;
    checks.push(
      check(
        'export',
        'audio_codec',
        Boolean(a && a.codec === th.spec.audioCodec),
        a ? 'major' : 'critical',
        a ? `Audio codec: ${a.codec.toUpperCase()} (target AAC).` : 'Missing audio stream in export.',
        { codec: a?.codec ?? null, sampleRate: a?.sampleRate ?? null, channels: a?.channels ?? null },
        a ? 'Transcode audio stream to AAC 48 kHz.' : 'Enable voiceover, source audio, or music and re-export.',
      ),
    );
  }

  if (media.faststart === null) {
    checks.push(unmeasured('export', 'faststart', 'Container atom order could not be inspected (non-MP4 container).'));
  } else {
    checks.push(
      check(
        'export',
        'faststart',
        media.faststart,
        'minor',
        media.faststart ? 'Fast-start enabled (moov precedes mdat).' : 'Fast-start not enabled: moov atom is at the end of the MP4.',
        { faststart: media.faststart },
        'Remux with -movflags +faststart for instant mobile streaming playback.',
      ),
    );
  }

  if (timeline && timeline.durationS > 0) {
    const drift = Math.abs(media.durationS - timeline.durationS);
    checks.push(
      check(
        'export',
        'duration',
        drift <= th.durationToleranceS,
        'major',
        `Export duration ${round(media.durationS)} s vs timeline ${round(timeline.durationS)} s.`,
        { actual: round(media.durationS), expected: round(timeline.durationS), driftS: round(drift) },
        'Recording stopped early or drifted; re-export with the tab active in the foreground.',
      ),
    );
  } else if (media.durationS <= 0.2) {
    checks.push(
      check(
        'export',
        'duration',
        false,
        'critical',
        `Export duration is too short (${round(media.durationS)} s).`,
        { actual: round(media.durationS) },
        'Re-export the reel; the encoder stopped prematurely.',
      ),
    );
  }

  const meetsSpec = checks.every((c) => c.passed || c.measured === false || c.severity === 'minor');
  return {
    checks,
    spec: {
      requested,
      actual: {
        width: v.width,
        height: v.height,
        fps: v.fps,
        videoCodec: v.codec,
        pixFmt: v.pixFmt,
        audioCodec: media.audio?.codec ?? null,
        audioSampleRate: media.audio?.sampleRate ?? null,
        audioChannels: media.audio?.channels ?? null,
        durationS: round(media.durationS),
        faststart: media.faststart,
        sizeBytes: media.sizeBytes,
      },
      meetsSpec,
      label: `${v.width}x${v.height}`,
    },
  };
}
