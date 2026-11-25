import type { DimensionKey } from './models.ts';

/**
 * Forge Reel Quality Evaluation Engine thresholds.
 * Weights strictly total 100 across the 7 required dimensions:
 *  - audio: 15
 *  - export: 15
 *  - visual: 20
 *  - captions: 15
 *  - storytelling: 15
 *  - pacing: 10
 *  - technical: 10
 * Every threshold is env-overridable via QUALITY_<NAME>.
 */
export interface Thresholds {
  weights: Record<DimensionKey, number>;
  /** 90–100 => Excellent (Ready to publish) */
  excellentScore: number;
  /** 80–89 => Good (Ready with minor warnings) */
  goodScore: number;
  /** 70–79 => Needs improvement (Revision recommended); <70 => Poor (Regeneration required) */
  improveScore: number;
  /** Legacy compatibility alias for pass gate (defaults to goodScore = 80). */
  passScore: number;
  /** When true, major defects demote PASS to NEEDS_IMPROVEMENT even if numeric score is high. */
  passRequiresNoMajor: boolean;
  spec: {
    width: number;
    height: number;
    fps: number;
    fpsTolerance: number;
    videoCodec: string;
    pixFmt: string;
    audioCodec: string;
    minAudioSampleRate: number;
  };
  durationToleranceS: number;
  minEffectiveFpsRatio: number; // effective (distinct) fps / spec fps
  minVideoBitrateKbps: number;
  maxBlurMean: number; // blurdetect mean above this = soft/blurry
  minSharpnessScore: number; // Laplacian edge energy floor when blurdetect is unavailable
  brightnessRange: [number, number]; // YAVG luma (0..255)
  minContrastSpread: number; // YMAX - YMIN minimum range
  maxBlackRatio: number;
  maxFreezeS: number;
  silentMeanDb: number; // mean volume below this => completely silent
  silentPeakDb: number; // max peak below this => completely silent
  silentRatioCritical: number; // silence fraction >= this => effectively silent
  speechBandMinDb: number; // 300-3400Hz band floor for speech presence
  loudnessRange: [number, number]; // LUFS
  rmsRangeDb: [number, number]; // RMS dBFS healthy band
  maxTruePeakDb: number;
  maxSilenceRatio: number;
  maxAvDriftS: number;
  maxStreamStartOffsetS: number;
  minCaptionCoverage: number; // fraction of script words present in captions
  criticalCaptionCoverage: number;
  maxFragmentRatio: number; // share of captions that are 1-2 word mid-sentence fragments
  minChunkDurationS: number;
  maxCaptionLines: number;
  safeCaptionYRange: [number, number]; // mobile-safe vertical % band (avoids top chrome, faces, bottom Shorts UI)
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
  const excellentScore = num(env, 'EXCELLENT_SCORE', 90);
  const goodScore = num(env, 'GOOD_SCORE', 80);
  const improveScore = num(env, 'IMPROVE_SCORE', 70);
  const passScore = num(env, 'PASS_SCORE', goodScore);
  return {
    weights: {
      audio: 15,
      export: 15,
      visual: 20,
      captions: 15,
      storytelling: 15,
      pacing: 10,
      technical: 10,
    },
    excellentScore,
    goodScore,
    improveScore,
    passScore,
    passRequiresNoMajor: env.QUALITY_PASS_ALLOW_MAJOR !== 'true',
    spec: {
      width: num(env, 'WIDTH', 1080),
      height: num(env, 'HEIGHT', 1920),
      fps: num(env, 'FPS', 30),
      fpsTolerance: num(env, 'FPS_TOLERANCE', 0.5),
      videoCodec: 'h264',
      pixFmt: 'yuv420p',
      audioCodec: 'aac',
      minAudioSampleRate: num(env, 'MIN_AUDIO_SAMPLE_RATE', 44100),
    },
    durationToleranceS: num(env, 'DURATION_TOLERANCE_S', 1.0),
    minEffectiveFpsRatio: num(env, 'MIN_EFFECTIVE_FPS_RATIO', 0.6),
    minVideoBitrateKbps: num(env, 'MIN_VIDEO_BITRATE_KBPS', 500),
    maxBlurMean: num(env, 'MAX_BLUR_MEAN', 8),
    minSharpnessScore: num(env, 'MIN_SHARPNESS_SCORE', 4),
    brightnessRange: [num(env, 'BRIGHTNESS_MIN', 18), num(env, 'BRIGHTNESS_MAX', 238)],
    minContrastSpread: num(env, 'MIN_CONTRAST_SPREAD', 25),
    maxBlackRatio: num(env, 'MAX_BLACK_RATIO', 0.05),
    maxFreezeS: num(env, 'MAX_FREEZE_S', 2.5),
    silentMeanDb: num(env, 'SILENT_MEAN_DB', -58),
    silentPeakDb: num(env, 'SILENT_PEAK_DB', -45),
    silentRatioCritical: num(env, 'SILENT_RATIO_CRITICAL', 0.95),
    speechBandMinDb: num(env, 'SPEECH_BAND_MIN_DB', -52),
    loudnessRange: [num(env, 'LOUDNESS_MIN', -22), num(env, 'LOUDNESS_MAX', -8)],
    rmsRangeDb: [num(env, 'RMS_MIN_DB', -36), num(env, 'RMS_MAX_DB', -6)],
    maxTruePeakDb: num(env, 'MAX_TRUE_PEAK_DB', -0.5),
    maxSilenceRatio: num(env, 'MAX_SILENCE_RATIO', 0.35),
    maxAvDriftS: num(env, 'MAX_AV_DRIFT_S', 0.5),
    maxStreamStartOffsetS: num(env, 'MAX_STREAM_START_OFFSET_S', 0.35),
    minCaptionCoverage: num(env, 'MIN_CAPTION_COVERAGE', 0.98),
    criticalCaptionCoverage: num(env, 'CRITICAL_CAPTION_COVERAGE', 0.8),
    maxFragmentRatio: num(env, 'MAX_FRAGMENT_RATIO', 0.35),
    minChunkDurationS: num(env, 'MIN_CHUNK_DURATION_S', 0.35),
    maxCaptionLines: num(env, 'MAX_CAPTION_LINES', 2),
    safeCaptionYRange: [num(env, 'SAFE_CAPTION_Y_MIN', 54), num(env, 'SAFE_CAPTION_Y_MAX', 80)],
    maxShotS: {
      source: num(env, 'MAX_SHOT_SOURCE_S', 10),
      broll: num(env, 'MAX_SHOT_BROLL_S', 7),
      image: num(env, 'MAX_SHOT_IMAGE_S', 6),
      motion: num(env, 'MAX_SHOT_MOTION_S', 7),
    },
    maxRepeatRatio: num(env, 'MAX_REPEAT_RATIO', 0.2),
    idealShotS: [num(env, 'IDEAL_SHOT_MIN_S', 1.5), num(env, 'IDEAL_SHOT_MAX_S', 6)],
    speechWpsRange: [num(env, 'SPEECH_WPS_MIN', 1.5), num(env, 'SPEECH_WPS_MAX', 4.2)],
  };
}
