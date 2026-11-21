import type { DimensionKey } from './models.ts';

/**
 * Quality thresholds. Defaults follow the delivery spec for vertical reels; every value can be overridden with an
 * environment variable (QUALITY_<NAME>) so operators can tune without code changes.
 */
export interface Thresholds {
  weights: Record<DimensionKey, number>;
  /** Classification bands: >= excellent → EXCELLENT, >= good → GOOD, >= improve → NEEDS_IMPROVEMENT, else POOR. */
  excellentScore: number;
  passScore: number; // = good
  /** GOOD/EXCELLENT also require no MAJOR defect ("ready with MINOR warnings"). QUALITY_PASS_ALLOW_MAJOR=true relaxes it. */
  passRequiresNoMajor: boolean;
  improveScore: number;
  /** Effective-detail factor (upscale) at which the picture is judged soft / badly upscaled. */
  minorUpscale: number;
  majorUpscale: number;
  /** Minimum share of expected speech time that must actually contain speech-like audio. */
  minVoiceoverCoverage: number;
  minRmsDb: number; // whole-mix RMS below this is "barely audible"
  maxStaticS: { source: number; broll: number; image: number; motion: number };
  minLuma: number;
  maxLuma: number;
  minContrast: number;
  safeArea: { top: number; bottom: number; side: number };
  spec: { width: number; height: number; fps: number; fpsTolerance: number; videoCodec: string; pixFmt: string; audioCodec: string };
  durationToleranceS: number;
  minEffectiveFpsRatio: number; // effective (distinct) fps / spec fps
  maxBlurMean: number; // blurdetect mean above this = soft/blurry
  maxBlackRatio: number;
  maxFreezeS: number;
  loudnessRange: [number, number]; // LUFS
  maxTruePeakDb: number;
  maxSilenceRatio: number;
  maxAvDriftS: number;
  minCaptionCoverage: number; // fraction of script words present in captions
  criticalCaptionCoverage: number;
  maxFragmentRatio: number; // share of captions that are 1-2 word mid-sentence fragments
  minChunkDurationS: number;
  maxCaptionLines: number;
  maxShotS: { source: number; broll: number; image: number; motion: number };
  maxRepeatRatio: number; // share of shots that reuse an earlier, non-adjacent shot
  idealShotS: [number, number];
  speechWpsRange: [number, number];
}

const num = (env: NodeJS.ProcessEnv, name: string, def: number) => {
  const v = Number(env[`QUALITY_${name}`]);
  return Number.isFinite(v) ? v : def;
};

export function loadThresholds(env: NodeJS.ProcessEnv = process.env): Thresholds {
  return {
    weights: { audio: 15, export: 15, visual: 20, captions: 15, story: 15, pacing: 10, technical: 10 },
    excellentScore: num(env, 'EXCELLENT_SCORE', 90),
    passScore: num(env, 'PASS_SCORE', 80),
    passRequiresNoMajor: env.QUALITY_PASS_ALLOW_MAJOR !== 'true',
    improveScore: num(env, 'IMPROVE_SCORE', 70),
    spec: {
      width: num(env, 'WIDTH', 1080),
      height: num(env, 'HEIGHT', 1920),
      fps: num(env, 'FPS', 30),
      fpsTolerance: num(env, 'FPS_TOLERANCE', 0.5),
      videoCodec: 'h264',
      pixFmt: 'yuv420p',
      audioCodec: 'aac',
    },
    durationToleranceS: num(env, 'DURATION_TOLERANCE_S', 1.0),
    minEffectiveFpsRatio: num(env, 'MIN_EFFECTIVE_FPS_RATIO', 0.6),
    maxBlurMean: num(env, 'MAX_BLUR_MEAN', 8),
    maxBlackRatio: num(env, 'MAX_BLACK_RATIO', 0.05),
    maxFreezeS: num(env, 'MAX_FREEZE_S', 2.5),
    loudnessRange: [num(env, 'LOUDNESS_MIN', -20), num(env, 'LOUDNESS_MAX', -9)],
    maxTruePeakDb: num(env, 'MAX_TRUE_PEAK_DB', -0.5),
    maxSilenceRatio: num(env, 'MAX_SILENCE_RATIO', 0.3),
    maxAvDriftS: num(env, 'MAX_AV_DRIFT_S', 0.5),
    minCaptionCoverage: num(env, 'MIN_CAPTION_COVERAGE', 0.98),
    criticalCaptionCoverage: num(env, 'CRITICAL_CAPTION_COVERAGE', 0.8),
    maxFragmentRatio: num(env, 'MAX_FRAGMENT_RATIO', 0.35),
    minChunkDurationS: num(env, 'MIN_CHUNK_DURATION_S', 0.35),
    maxCaptionLines: num(env, 'MAX_CAPTION_LINES', 2),
    maxShotS: {
      source: num(env, 'MAX_SHOT_SOURCE_S', 10),
      broll: num(env, 'MAX_SHOT_BROLL_S', 7),
      image: num(env, 'MAX_SHOT_IMAGE_S', 6),
      motion: num(env, 'MAX_SHOT_MOTION_S', 7),
    },
    maxRepeatRatio: num(env, 'MAX_REPEAT_RATIO', 0.2),
    idealShotS: [num(env, 'IDEAL_SHOT_MIN_S', 1.5), num(env, 'IDEAL_SHOT_MAX_S', 6)],
    speechWpsRange: [num(env, 'SPEECH_WPS_MIN', 1.6), num(env, 'SPEECH_WPS_MAX', 4.0)],
    minorUpscale: num(env, 'MINOR_UPSCALE', 3),
    majorUpscale: num(env, 'MAJOR_UPSCALE', 4),
    minVoiceoverCoverage: num(env, 'MIN_VOICEOVER_COVERAGE', 0.6),
    minRmsDb: num(env, 'MIN_RMS_DB', -40),
    maxStaticS: {
      source: num(env, 'MAX_STATIC_SOURCE_S', 12),
      broll: num(env, 'MAX_STATIC_BROLL_S', 8),
      image: num(env, 'MAX_STATIC_IMAGE_S', 6),
      motion: num(env, 'MAX_STATIC_MOTION_S', 8),
    },
    minLuma: num(env, 'MIN_LUMA', 30),
    maxLuma: num(env, 'MAX_LUMA', 225),
    minContrast: num(env, 'MIN_CONTRAST', 18),
    // YouTube Shorts overlays: title/channel at the bottom ~20%, top bar ~8%, action buttons on the right edge.
    safeArea: { top: num(env, 'SAFE_TOP', 0.08), bottom: num(env, 'SAFE_BOTTOM', 0.8), side: num(env, 'SAFE_SIDE', 0.04) },
  };
}
