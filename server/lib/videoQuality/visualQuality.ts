import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';

/** Visual quality from the decoded frames: render resolution, sharpness, black frames, freezes, dropped frames. */
export function evaluateVisual(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  const v = media?.video;
  if (!media || !v) return [check('visual', 'frames_present', false, 'critical', 'No decodable video frames.', {}, 'Export again.')];
  const a = media.analysis;
  const checks: Check[] = [];
  const target = timeline?.target || th.spec;
  // Pixels actually rendered, independent of any later scaling: upscaling a small render does not add detail.
  const pixelRatio = (v.width * v.height) / (target.width * target.height);
  checks.push(check('visual', 'render_resolution', pixelRatio >= 0.99, pixelRatio < 0.5 ? 'major' : 'minor',
    `Rendered at ${v.width}x${v.height} (${Math.round(pixelRatio * 100)}% of the target pixels).`,
    { width: v.width, height: v.height, targetWidth: target.width, targetHeight: target.height, pixelRatio: round(pixelRatio, 3) },
    'Re-export so the encoder keeps the full canvas size; do not upscale a small recording.'));
  if (a.blurMean === null) checks.push(unmeasured('visual', 'sharpness', 'Blur could not be measured.'));
  else checks.push(check('visual', 'sharpness', a.blurMean <= th.maxBlurMean, 'major', `Blur index ${round(a.blurMean)} (limit ${th.maxBlurMean}).`, { blurMean: round(a.blurMean, 3) }, 'Use higher-resolution source footage or a higher export bitrate.'));
  const blackS = a.blackSegments.reduce((s, b) => s + Math.max(0, (Number.isFinite(b.end) ? b.end : media.durationS) - b.start), 0);
  const blackRatio = media.durationS ? blackS / media.durationS : 0;
  checks.push(check('visual', 'black_frames', blackRatio <= th.maxBlackRatio, blackRatio > 0.5 ? 'critical' : 'major',
    `${round(blackS, 1)} s of black frames (${Math.round(blackRatio * 100)}%).`, { seconds: round(blackS), segments: a.blackSegments.slice(0, 10) },
    'A scene failed to load: replace its media or re-export.'));
  const longestFreeze = a.freezeSegments.reduce((m, f) => Math.max(m, f.end - f.start), 0);
  checks.push(check('visual', 'frozen_video', longestFreeze <= th.maxFreezeS, longestFreeze > media.durationS * 0.5 ? 'critical' : 'major',
    longestFreeze ? `Longest frozen stretch: ${round(longestFreeze, 1)} s.` : 'No frozen stretches.', { longestFreezeS: round(longestFreeze), segments: a.freezeSegments.slice(0, 10) },
    'Footage stopped playing during export; keep the tab in the foreground and re-export.'));
  if (a.effectiveFps === null) checks.push(unmeasured('visual', 'dropped_frames', 'Distinct-frame rate could not be measured.'));
  else {
    const ratio = a.effectiveFps / (target.fps || 30);
    checks.push(check('visual', 'dropped_frames', ratio >= th.minEffectiveFpsRatio, 'minor',
      `${a.effectiveFps} distinct frames per second (${Math.round(ratio * 100)}% of ${target.fps}).`, { effectiveFps: a.effectiveFps, ratio: round(ratio, 2) },
      'The recorder could not keep up: close other tabs/apps or export at 720p.'));
  }
  return checks;
}
