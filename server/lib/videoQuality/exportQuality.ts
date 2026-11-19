import { check, round, unmeasured } from './checks.ts';
import type { Check, ExportSpecReport, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';

/** Export integrity: the file must actually be what it claims (dimensions, codec, pixel format, fps, audio, faststart). */
export function evaluateExport(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): { checks: Check[]; spec: ExportSpecReport } {
  const spec = { ...th.spec, ...(timeline?.target || {}) };
  const requested = { width: spec.width, height: spec.height, fps: spec.fps, videoCodec: th.spec.videoCodec, pixFmt: th.spec.pixFmt, audioCodec: th.spec.audioCodec };
  const checks: Check[] = [];
  if (!media) {
    return {
      checks: [check('export', 'file_readable', false, 'critical', 'No video file to inspect.', {}, 'Export again.')],
      spec: { requested, actual: null, meetsSpec: false, label: 'unknown' },
    };
  }
  const v = media.video;
  if (!v) {
    checks.push(check('export', 'video_stream', false, 'critical', 'The file has no video stream.', { container: media.container }, 'Export again.'));
    return { checks, spec: { requested, actual: null, meetsSpec: false, label: 'no video' } };
  }
  const dimsOk = v.width === spec.width && v.height === spec.height;
  checks.push(check('export', 'dimensions', dimsOk, 'critical',
    dimsOk ? `Actual size ${v.width}x${v.height} matches the export setting.` : `Actual size is ${v.width}x${v.height}, not the requested ${spec.width}x${spec.height}.`,
    { actual: `${v.width}x${v.height}`, requested: `${spec.width}x${spec.height}` },
    'The browser encoder recorded a smaller frame than the canvas. Export again with the tab in the foreground, or choose 720p.'));
  const ratioOk = Math.abs(v.width / v.height - 9 / 16) < 0.01;
  checks.push(check('export', 'aspect_ratio', ratioOk, 'major', ratioOk ? 'Aspect ratio is 9:16.' : `Aspect ratio is ${round(v.width / v.height, 3)}, not 9:16 (0.5625).`, { width: v.width, height: v.height }));
  checks.push(check('export', 'video_codec', v.codec === th.spec.videoCodec, 'major', `Video codec: ${v.codec}.`, { codec: v.codec, profile: v.profile }, 'Re-encode to H.264.'));
  checks.push(check('export', 'pixel_format', v.pixFmt === th.spec.pixFmt, 'major', `Pixel format: ${v.pixFmt}.`, { pixFmt: v.pixFmt }, 'Re-encode to yuv420p for universal playback.'));
  const fpsOk = Math.abs(v.fps - spec.fps) <= th.spec.fpsTolerance;
  checks.push(check('export', 'frame_rate', fpsOk, 'major', `Frame rate: ${v.fps} fps (target ${spec.fps}).`, { fps: v.fps, frames: v.frames, target: spec.fps }, 'Conform to a constant frame rate.'));
  if (timeline?.audio.required) {
    const a = media.audio;
    checks.push(check('export', 'audio_codec', Boolean(a && a.codec === th.spec.audioCodec), a ? 'major' : 'critical',
      a ? `Audio codec: ${a.codec}.` : 'No audio track although the reel needs audio.', { codec: a?.codec ?? null }, a ? 'Re-encode audio to AAC.' : 'Export again; check that music, voice or source audio is enabled.'));
  }
  if (media.faststart === null) checks.push(unmeasured('export', 'faststart', 'Container layout could not be inspected.'));
  else checks.push(check('export', 'faststart', media.faststart, 'minor', media.faststart ? 'Metadata is at the front (fast start).' : 'Metadata is at the end: web players must download the file before playing.', { faststart: media.faststart }, 'Remux with +faststart.'));
  if (timeline) {
    const drift = Math.abs(media.durationS - timeline.durationS);
    checks.push(check('export', 'duration', drift <= th.durationToleranceS, 'major',
      `Duration ${round(media.durationS)} s vs timeline ${round(timeline.durationS)} s.`, { actual: round(media.durationS), expected: round(timeline.durationS) },
      'The recording was cut short or ran long; export again with the tab in the foreground.'));
  }
  const meetsSpec = checks.every((c) => c.passed || c.measured === false || c.severity === 'minor');
  return {
    checks,
    spec: {
      requested,
      actual: {
        width: v.width, height: v.height, fps: v.fps, videoCodec: v.codec, pixFmt: v.pixFmt,
        audioCodec: media.audio?.codec ?? null, durationS: round(media.durationS), faststart: media.faststart, sizeBytes: media.sizeBytes,
      },
      meetsSpec,
      label: `${v.width}x${v.height}`,
    },
  };
}
