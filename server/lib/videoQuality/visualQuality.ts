import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline, TimelineBeat } from './models.ts';
import { repeatedShots, segmentShots, type Shot } from './similarity.ts';
import type { Thresholds } from './thresholds.ts';

/** Beats merged into visual shots: consecutive beats on the same asset are one continuous shot. */
export function timelineShots(beats: TimelineBeat[]): Array<{ start: number; end: number; asset: string; kind: TimelineBeat['kind'] }> {
  const out: Array<{ start: number; end: number; asset: string; kind: TimelineBeat['kind'] }> = [];
  for (const b of beats) {
    const asset = b.asset || `beat:${b.text}`;
    const last = out[out.length - 1];
    if (last && last.asset === asset && Math.abs(last.end - b.start_s) < 0.3) last.end = b.end_s;
    else out.push({ start: b.start_s, end: b.end_s, asset, kind: b.kind });
  }
  return out;
}

const kindAt = (t: Timeline | null, at: number): keyof Thresholds['maxStaticS'] => {
  const b = t?.beats.find((x) => at >= x.start_s && at < x.end_s);
  return (b?.kind || (t?.beats.every((x) => x.kind === 'source') ? 'source' : 'broll')) as keyof Thresholds['maxStaticS'];
};

/**
 * Visual quality (20 pts): resolution actually rendered and actually DETAILED, sharpness, black/frozen frames,
 * static visuals, scene diversity and repetition, brightness/contrast, subject kept clear of captions, every planned
 * scene rendered.
 */
export function evaluateVisual(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): { checks: Check[]; shots: Shot[] } {
  const checks: Check[] = [];
  const v = media?.video;
  if (media && !v) return { checks: [check('visual', 'frames_present', false, 'critical', 'No decodable video frames.', {}, 'Export again.')], shots: [] };
  const target = timeline?.target || th.spec;
  const dur = media?.durationS || timeline?.durationS || 0;
  const shots = media && v ? segmentShots(dur, media.analysis.sceneCuts, media.analysis.frameHashes) : [];

  if (media && v) {
    const a = media.analysis;
    // Pixels actually rendered, independent of any later scaling: upscaling a small render does not add detail.
    const pixelRatio = (v.width * v.height) / (target.width * target.height);
    checks.push(check('visual', 'render_resolution', pixelRatio >= 0.99, pixelRatio < 0.5 ? 'major' : 'minor',
      `Rendered at ${v.width}x${v.height} (${Math.round(pixelRatio * 100)}% of the target pixels).`,
      { width: v.width, height: v.height, targetWidth: target.width, targetHeight: target.height, pixelRatio: round(pixelRatio, 3) },
      'Re-export so the encoder keeps the full canvas size; do not upscale a small recording.'));
    if (!a.detail) checks.push(unmeasured('visual', 'effective_detail', 'The picture is too smooth (flat colours/gradients) to judge real detail.'));
    else {
      const f = a.detail.effectiveFactor;
      checks.push(check('visual', 'effective_detail', f < th.minorUpscale, f >= th.majorUpscale ? 'major' : 'minor',
        f > 1
          ? `The frame is ${v.width}x${v.height}, but the picture holds only about ${a.detail.effectiveWidth}x${a.detail.effectiveHeight} of real detail (a smaller image stretched ${f}x).`
          : `The picture carries real detail at ${v.width}x${v.height}.`,
        { ...a.detail, method: 'median tile PSNR of a down/up-scale round trip (>= 43 dB = no detail lost)' },
        'Use higher-resolution footage for these scenes (e.g. your own video file instead of a thumbnail), or accept a smaller export; upscaling does not add detail.'));
    }
    if (a.blurMean === null) checks.push(unmeasured('visual', 'sharpness', 'Blur could not be measured.'));
    else checks.push(check('visual', 'sharpness', a.blurMean <= th.maxBlurMean, 'major', `Blur index ${round(a.blurMean)} (limit ${th.maxBlurMean}).`, { blurMean: round(a.blurMean, 3) }, 'Use sharper source footage or a higher export bitrate.'));
    const blackS = a.blackSegments.reduce((s, b) => s + Math.max(0, (Number.isFinite(b.end) ? b.end : media.durationS) - b.start), 0);
    const blackRatio = media.durationS ? blackS / media.durationS : 0;
    checks.push(check('visual', 'black_frames', blackRatio <= th.maxBlackRatio, blackRatio > 0.5 ? 'critical' : 'major',
      `${round(blackS, 1)} s of black frames (${Math.round(blackRatio * 100)}%).`, { seconds: round(blackS), segments: a.blackSegments.slice(0, 10) },
      'A scene failed to load: replace its media or re-export.'));
    const longestFreeze = a.freezeSegments.reduce((m, f) => Math.max(m, f.end - f.start), 0);
    checks.push(check('visual', 'frozen_video', longestFreeze <= th.maxFreezeS, longestFreeze > media.durationS * 0.5 ? 'critical' : 'major',
      longestFreeze ? `Longest frozen stretch (identical frames): ${round(longestFreeze, 1)} s.` : 'No frozen stretches.', { longestFreezeS: round(longestFreeze), segments: a.freezeSegments.slice(0, 10) },
      'Footage stopped playing during export; keep the tab in the foreground and re-export.'));
    if (a.effectiveFps === null) checks.push(unmeasured('visual', 'dropped_frames', 'Distinct-frame rate could not be measured.'));
    else {
      const ratio = a.effectiveFps / (target.fps || 30);
      // A still image legitimately repeats frames; only judge when the picture is supposed to move.
      const stillOnly = timeline?.beats.length && timeline.beats.every((b) => b.kind === 'image');
      checks.push(check('visual', 'dropped_frames', ratio >= th.minEffectiveFpsRatio || Boolean(stillOnly), 'minor',
        `${a.effectiveFps} distinct frames per second (${Math.round(ratio * 100)}% of ${target.fps}).`, { effectiveFps: a.effectiveFps, ratio: round(ratio, 2) },
        'The recorder could not keep up: close other tabs/apps or export at 720p.'));
    }
    const st = a.stability;
    if (!st) checks.push(unmeasured('visual', 'static_visuals', 'Visual states could not be measured.'));
    else {
      // Longest visually unchanged stretch, judged against the scene type shown at that time.
      let worst: { start: number; end: number; len: number; kind: string; limit: number } | null = null;
      for (const s of st.states) {
        const kind = kindAt(timeline, (s.start + s.end) / 2);
        const limit = th.maxStaticS[kind];
        const len = s.end - s.start;
        if (len > limit && (!worst || len / limit > worst.len / worst.limit)) worst = { start: s.start, end: s.end, len, kind, limit };
      }
      const dominant = media.durationS >= 12 && st.longestStaticS >= media.durationS * 0.8;
      checks.push(check('visual', 'static_visuals', !worst, dominant || (worst && worst.len > worst.limit * 2) ? 'major' : 'minor',
        worst
          ? dominant
            ? `One unchanged picture fills ${round(st.longestStaticS, 1)} s of the ${round(media.durationS, 1)} s reel${worst.kind === 'image' ? ' (a still image with a slow zoom)' : ''}.`
            : `The picture does not change for ${round(worst.len, 1)} s at ${round(worst.start, 1)} s (${worst.kind} scenes: limit ${worst.limit} s).`
          : `The picture changes regularly (${st.states.length} visual states; longest ${round(st.longestStaticS, 1)} s).`,
        { states: st.states.length, distinctVisuals: st.distinctVisuals, longestStaticS: round(st.longestStaticS, 1), worst, method: '2 fps thumbnails vs. each state\'s first frame (a slow zoom stays one state)' },
        worst?.kind === 'source' ? 'Add framing changes (punch-ins) at sentence boundaries or a B-roll cut-away.' : 'Give each scene its own footage that matches what is being said.'));
      const beatsN = timeline?.beats.length || 0;
      const sourceOnly = Boolean(timeline?.beats.length && timeline.beats.every((b) => b.kind === 'source'));
      const wanted = Math.max(1, Math.min(beatsN || Infinity, Math.ceil(media.durationS / (sourceOnly ? th.maxStaticS.source : th.idealShotS[1]))));
      const enough = st.distinctVisuals >= Math.ceil(wanted * 0.5);
      checks.push(check('visual', 'scene_diversity', enough, st.distinctVisuals <= 1 && media.durationS >= 12 ? 'major' : 'minor',
        `${st.distinctVisuals} distinct picture(s) across ${round(media.durationS, 1)} s (${wanted} expected for ${beatsN || 'its'} scene(s)).`,
        { distinctVisuals: st.distinctVisuals, expected: wanted, scenes: beatsN }, 'Show different footage for different ideas in the script.'));
      checks.push(check('visual', 'exposure', st.meanLuma >= th.minLuma && st.meanLuma <= th.maxLuma && st.darkRatio <= 0.2, 'minor',
        `Average brightness ${st.meanLuma}/255; ${Math.round(st.darkRatio * 100)}% of sampled frames are very dark.`, { meanLuma: st.meanLuma, darkRatio: st.darkRatio, range: [th.minLuma, th.maxLuma] },
        st.meanLuma < th.minLuma ? 'Brighten the footage or choose brighter scenes.' : 'Reduce exposure; the picture is washed out.'));
      checks.push(check('visual', 'contrast', st.contrast >= th.minContrast, 'minor', `Contrast (luma spread) ${st.contrast} (minimum ${th.minContrast}).`, { contrast: st.contrast },
        'The picture is flat; choose footage with more contrast.'));
    }
    const reps = repeatedShots(shots);
    const ratio = shots.length ? reps.length / shots.length : 0;
    checks.push(check('visual', 'repeated_shots', ratio <= th.maxRepeatRatio, ratio > 0.5 ? 'major' : 'minor',
      `${reps.length} of ${shots.length} shots repeat an earlier shot.`, { shots: shots.length, repeats: reps.slice(0, 10) },
      'Pick a different clip for repeated scenes (next search result or another query).'));
  }

  if (timeline && timeline.beats.length) {
    const tShots = timelineShots(timeline.beats);
    const reused = tShots.filter((s, i) => s.kind !== 'source' && tShots.slice(0, Math.max(0, i - 1)).some((p) => p.asset === s.asset));
    checks.push(check('visual', 'asset_reuse', reused.length === 0, reused.length > tShots.length / 3 ? 'major' : 'minor',
      `${reused.length} scene(s) reuse media already shown earlier.`, { reused: reused.slice(0, 10).map((s) => ({ at: round(s.start), asset: s.asset })) },
      'Choose distinct footage per scene.'));
    // Every planned scene must actually have been drawn (asset reported by the renderer) and scenes must cover the reel.
    const reported = timeline.beats.some((b) => b.asset !== undefined);
    const missing = reported ? timeline.beats.map((b, i) => ({ i, b })).filter(({ b }) => !b.asset || !b.text.trim()) : [];
    const sorted = [...timeline.beats].sort((x, y) => x.start_s - y.start_s);
    const gaps: Array<{ from: number; to: number }> = [];
    let cursor = 0;
    for (const b of sorted) {
      if (b.start_s - cursor > 0.5) gaps.push({ from: round(cursor), to: round(b.start_s) });
      cursor = Math.max(cursor, b.end_s);
    }
    if (timeline.durationS - cursor > 0.5) gaps.push({ from: round(cursor), to: round(timeline.durationS) });
    const gapS = gaps.reduce((s, g) => s + g.to - g.from, 0);
    const missingShare = (missing.length + gapS / Math.max(1, timeline.durationS / timeline.beats.length)) / timeline.beats.length;
    checks.push(check('visual', 'scenes_rendered', missing.length === 0 && gaps.length === 0, missingShare > 0.25 ? 'critical' : 'major',
      missing.length || gaps.length
        ? `${missing.length} planned scene(s) were not rendered${gaps.length ? ` and ${round(gapS, 1)} s of the reel has no scene` : ''}.`
        : `All ${timeline.beats.length} planned scenes were rendered and cover the reel.`,
      { missing: missing.slice(0, 10).map(({ i, b }) => ({ scene: i + 1, text: b.text.slice(0, 60), start: b.start_s })), gaps: gaps.slice(0, 10), scenes: timeline.beats.length },
      'Regenerate the missing scenes (new media or text) and export again.'));
    if (typeof timeline.captions.subjectOverlap === 'number') {
      const o = timeline.captions.subjectOverlap;
      checks.push(check('visual', 'subject_clear', o <= 0.15, o > 0.5 ? 'major' : 'minor',
        `Captions covered the detected subject during ${Math.round(o * 100)}% of caption time.`, { subjectOverlap: round(o, 3), method: 'skin-tone region under the caption box, sampled per scene' },
        'Move captions below the speaker (lower caption position) or reframe the shot.'));
    } else checks.push(unmeasured('visual', 'subject_clear', 'Subject position was not measured for this reel.'));
  } else if (!media) {
    checks.push(unmeasured('visual', 'shots', 'No media or timeline to measure.'));
  }
  return { checks, shots };
}
