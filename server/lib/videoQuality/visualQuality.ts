import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import { repeatedShots, segmentShots, type Shot } from './similarity.ts';
import { timelineShots } from './sceneQuality.ts';
import { tokens } from './captionQuality.ts';
import type { Thresholds } from './thresholds.ts';

const STOP = new Set('the a an and or but so of to in on at for with is are was be it this that you your i we they my our'.split(' '));

/**
 * Visual quality evaluation (Weight: 20).
 * Evaluates decoded frame properties AND visual diversity:
 *  - Render resolution ratio (never hides upscaling)
 *  - Sharpness / blur (blurdetect or Laplacian edge energy)
 *  - Brightness & contrast (luma distribution)
 *  - Black frames & frozen frames
 *  - Scene diversity & shot variety
 *  - Visual repetition (perceptual dHash + timeline asset reuse)
 *  - Longest static shot duration
 *  - Visual relevance to narration
 */
export function evaluateVisual(
  media: MediaFacts | null,
  timeline: Timeline | null,
  th: Thresholds,
): { checks: Check[]; shots: Shot[] } {
  const v = media?.video;
  const dur = media?.durationS || timeline?.durationS || 0;
  const shots = v ? segmentShots(dur, media!.analysis.sceneCuts, media!.analysis.frameHashes) : [];
  const checks: Check[] = [];

  if (!media || !v) {
    checks.push(check('visual', 'frames_present', false, 'critical', 'No decodable video frames.', {}, 'Re-export the video.'));
  } else {
    const a = media.analysis;
    const target = timeline?.target || th.spec;
    const pixelRatio = (v.width * v.height) / (target.width * target.height);
    checks.push(
      check(
        'visual',
        'render_resolution',
        pixelRatio >= 0.99,
        pixelRatio < 0.5 ? 'major' : 'minor',
        `Rendered at ${v.width}×${v.height} (${Math.round(pixelRatio * 100)}% of target ${target.width}×${target.height} pixels).`,
        { width: v.width, height: v.height, targetWidth: target.width, targetHeight: target.height, pixelRatio: round(pixelRatio, 3) },
        'Re-export at full canvas resolution; never upscale a low-resolution preview.',
      ),
    );

    // Sharpness: prefer blurdetect if FFmpeg supports it, else use our Laplacian edge-energy measurement.
    if (a.blurMean !== null) {
      checks.push(
        check(
          'visual',
          'sharpness',
          a.blurMean <= th.maxBlurMean,
          'major',
          `Sharpness blur index ${round(a.blurMean)} (limit ${th.maxBlurMean}).`,
          { blurMean: round(a.blurMean, 3), maxBlurMean: th.maxBlurMean },
          'Use sharper 1080p footage or increase export bitrate.',
        ),
      );
    } else if (a.sharpnessScore !== null) {
      checks.push(
        check(
          'visual',
          'sharpness',
          a.sharpnessScore >= th.minSharpnessScore,
          'minor',
          `Edge sharpness score ${round(a.sharpnessScore, 2)} (minimum ${th.minSharpnessScore}).`,
          { sharpnessScore: round(a.sharpnessScore, 2), minSharpnessScore: th.minSharpnessScore, method: 'laplacian_edge_energy' },
          'Replace blurry or overly flat visuals with higher-detail scenes.',
        ),
      );
    } else {
      checks.push(unmeasured('visual', 'sharpness', 'Sharpness could not be measured.'));
    }

    // Brightness & contrast (from 1 fps grayscale luminance stats).
    if (a.brightnessMean !== null && a.contrastSpread !== null) {
      const [bLo, bHi] = th.brightnessRange;
      const brightOk = a.brightnessMean >= bLo && a.brightnessMean <= bHi;
      const contrastOk = a.contrastSpread >= th.minContrastSpread;
      checks.push(
        check(
          'visual',
          'brightness_contrast',
          brightOk && contrastOk,
          !brightOk && (a.brightnessMean < 10 || a.brightnessMean > 248) ? 'major' : 'minor',
          brightOk && contrastOk
            ? `Brightness (${round(a.brightnessMean, 0)}/255) and contrast spread (${round(a.contrastSpread, 0)}) are well balanced.`
            : `Exposure/contrast issue: mean luma ${round(a.brightnessMean, 0)}/255 (target ${bLo}–${bHi}), contrast spread ${round(a.contrastSpread, 0)} (min ${th.minContrastSpread}).`,
          { brightnessMean: a.brightnessMean, contrastSpread: a.contrastSpread, brightnessRange: th.brightnessRange, minContrastSpread: th.minContrastSpread },
          'Adjust scene lighting/color balance or choose higher-contrast stock visuals.',
        ),
      );
    }

    // Black frames.
    const blackS = a.blackSegments.reduce((s, b) => s + Math.max(0, (Number.isFinite(b.end) ? b.end : media.durationS) - b.start), 0);
    const blackRatio = media.durationS ? blackS / media.durationS : 0;
    checks.push(
      check(
        'visual',
        'black_frames',
        blackRatio <= th.maxBlackRatio,
        blackRatio > 0.5 ? 'critical' : 'major',
        `${round(blackS, 1)} s of black frames (${Math.round(blackRatio * 100)}%).`,
        { seconds: round(blackS), ratio: round(blackRatio, 3), segments: a.blackSegments.slice(0, 10) },
        'One or more scenes rendered black; replace failed media assets and re-export.',
      ),
    );

    // Frozen / static frames.
    const longestFreeze = a.freezeSegments.reduce((m, f) => Math.max(m, Math.max(0, f.end - f.start)), 0);
    checks.push(
      check(
        'visual',
        'frozen_video',
        longestFreeze <= th.maxFreezeS,
        longestFreeze > media.durationS * 0.5 && media.durationS >= 4 ? 'critical' : 'major',
        longestFreeze > 0 ? `Longest frozen/static stretch: ${round(longestFreeze, 1)} s (limit ${th.maxFreezeS} s).` : 'No frozen video stretches detected.',
        { longestFreezeS: round(longestFreeze), limitS: th.maxFreezeS, segments: a.freezeSegments.slice(0, 10) },
        'Replace static footage with motion clips or add scene cuts / framing motion.',
      ),
    );

    // Perceptual-hash repeated shots & scene diversity from the actual decoded pixels.
    const reps = repeatedShots(shots);
    const repRatio = shots.length ? reps.length / shots.length : 0;
    checks.push(
      check(
        'visual',
        'repeated_shots',
        repRatio <= th.maxRepeatRatio,
        repRatio > 0.5 ? 'major' : 'minor',
        `${reps.length} of ${shots.length} visual shot(s) repeat an earlier shot.`,
        { shots: shots.length, repeats: reps.slice(0, 10) },
        'Replace repeated shots with distinct footage that progresses the narrative.',
      ),
    );

    // For reels >= 6s, a single static visual shot without cuts or motion variation lacks visual progression.
    if (dur >= 6 && shots.length <= 1 && (!timeline || !timeline.beats.every((b) => b.kind === 'source'))) {
      checks.push(
        check(
          'visual',
          'scene_diversity',
          false,
          'major',
          `Only ${shots.length} distinct visual shot detected across a ${round(dur, 1)} s reel.`,
          { detectedShots: shots.length, durationS: round(dur, 1), sceneCuts: a.sceneCuts.length },
          'Introduce narrative-driven scene changes every 2–5 seconds instead of holding one visual.',
        ),
      );
    } else if (dur >= 4) {
      checks.push(
        check(
          'visual',
          'scene_diversity',
          true,
          'minor',
          `${shots.length} visual shot(s) detected across ${round(dur, 1)} s.`,
          { detectedShots: shots.length, durationS: round(dur, 1), sceneCuts: a.sceneCuts.length },
        ),
      );
    }
  }

  // Timeline-level visual variety, asset reuse, shot length, and visual relevance to narration.
  if (timeline && timeline.beats.length > 0) {
    const tShots = timelineShots(timeline.beats);
    const reused = tShots.filter(
      (s, i) => !['source'].includes(String(s.kind)) && tShots.slice(0, Math.max(0, i - 1)).some((p) => p.asset === s.asset),
    );
    checks.push(
      check(
        'visual',
        'asset_reuse',
        reused.length === 0,
        reused.length > tShots.length / 3 ? 'major' : 'minor',
        reused.length === 0
          ? 'Every scene uses a distinct visual asset.'
          : `${reused.length} scene(s) reuse media already shown earlier.`,
        { reused: reused.slice(0, 10).map((s) => ({ at: round(s.start), asset: s.asset })), totalShots: tShots.length },
        'Assign distinct footage or visual scenes to each narrative beat.',
      ),
    );

    let worst: { kind: string; length: number; limit: number; start: number } | null = null;
    for (const s of tShots) {
      const kind = (s.kind || 'broll') as keyof Thresholds['maxShotS'];
      const limit = th.maxShotS[kind] ?? th.maxShotS.broll;
      const cutsInside = media?.video ? media.analysis.sceneCuts.filter((c) => c > s.start + 0.3 && c < s.end - 0.3) : [];
      const bounds = [s.start, ...cutsInside, s.end];
      for (let i = 0; i < bounds.length - 1; i++) {
        const len = bounds[i + 1] - bounds[i];
        if (len > limit && (!worst || len - limit > worst.length - worst.limit)) {
          worst = { kind, length: round(len, 1), limit, start: round(bounds[i]) };
        }
      }
    }
    checks.push(
      check(
        'visual',
        'shot_length',
        !worst,
        worst && worst.length > worst.limit * 1.5 ? 'major' : 'minor',
        worst
          ? `A ${worst.kind} shot runs ${worst.length} s unchanged at ${worst.start} s (limit ${worst.limit} s).`
          : 'All visual shots stay within healthy duration limits.',
        { worst },
        worst?.kind === 'source'
          ? 'Enable punch-in reframing on sentence boundaries or insert B-roll cutaways.'
          : 'Split long scenes or introduce a fresh visual angle.',
      ),
    );

    // Visual relevance to narration (keyword alignment for non-speaker-only scenes).
    const judged = timeline.beats.filter((b) => b.kind !== 'source' && b.visual_keywords);
    if (judged.length > 0) {
      const unrelated = judged.filter((b) => {
        const said = new Set(tokens(b.text).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));
        return !tokens(b.visual_keywords || '').some((w) => said.has(w.slice(0, 5)));
      });
      const ratio = unrelated.length / judged.length;
      checks.push(
        check(
          'visual',
          'visual_relevance',
          ratio <= 0.5,
          'minor',
          ratio <= 0.5
            ? `${judged.length - unrelated.length} of ${judged.length} scenes have visual keywords aligned to spoken text.`
            : `${unrelated.length} of ${judged.length} scenes have visuals with low keyword overlap against narration.`,
          { unrelated: unrelated.slice(0, 6).map((b) => ({ text: b.text.slice(0, 60), visual: b.visual_keywords })) },
          'Retrieve stock visuals matching the concrete nouns and actions in each spoken line.',
        ),
      );
    }
  } else if (timeline && timeline.beats.length === 0) {
    checks.push(
      check(
        'visual',
        'missing_scenes',
        false,
        'major',
        'No visual scenes are defined in the reel timeline.',
        { beats: 0 },
        'Generate or add at least 3 distinct scenes to the timeline.',
      ),
    );
  }

  return { checks, shots };
}
