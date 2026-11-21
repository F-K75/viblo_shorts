// Types shared by the Forge Reel Quality Evaluation Engine.
// Every check carries measurable evidence so no score is ever assigned arbitrarily.

export type Severity = 'info' | 'minor' | 'major' | 'critical';

/** Legacy gate status preserved for backward compatibility alongside the 4-tier classification. */
export type GateStatus = 'PASS' | 'NEEDS_IMPROVEMENT' | 'REJECTED';

/** 4-tier publishing quality classification. */
export type QualityClassification = 'Excellent' | 'Good' | 'Needs improvement' | 'Poor';

/** Recommended publishing action mapped from classification (and overridden by critical failures). */
export type QualityAction =
  | 'Ready to publish'
  | 'Ready with minor warnings'
  | 'Revision recommended'
  | 'Regeneration required';

/**
 * 7 weighted evaluation dimensions totaling 100 points:
 *  - audio (15): Audio quality
 *  - export (15): Video and export quality
 *  - visual (20): Visual quality
 *  - captions (15): Caption quality
 *  - storytelling (15): Storytelling and narrative
 *  - pacing (10): Pacing and engagement
 *  - technical (10): Technical consistency
 */
export type DimensionKey =
  | 'audio'
  | 'export'
  | 'visual'
  | 'captions'
  | 'storytelling'
  | 'pacing'
  | 'technical';

export interface Check {
  id: string;
  dimension: DimensionKey;
  passed: boolean;
  severity: Severity; // severity if failed
  message: string;
  evidence: Record<string, unknown>;
  suggestion?: string;
  /** False when the check could not be measured (no evidence available): excluded from the score, reported. */
  measured?: boolean;
}

export interface DimensionResult {
  key: DimensionKey;
  label: string;
  weight: number;
  /** 0..1 */
  score: number;
  points: number;
  checks: Check[];
}

export type RepairActionType =
  | 'conform_encode'
  | 'rerecord_export'
  | 'regenerate_voiceover'
  | 'remux_audio'
  | 'realign_captions'
  | 'enable_phrase_captions'
  | 'adjust_caption_safe_zone'
  | 'diversify_visuals'
  | 'strengthen_hook'
  | 'adjust_pacing'
  | 'retrieve_relevant_assets';

export interface RepairRecommendation {
  id: string;
  issueId: string;
  dimension: DimensionKey;
  severity: Severity;
  autoRepairable: boolean;
  repairAction: RepairActionType;
  title: string;
  description: string;
  evidence: string;
}

/** Facts measured from the media file (ffprobe + ffmpeg analysis filters). */
export interface MediaFacts {
  container: string;
  durationS: number;
  sizeBytes: number;
  faststart: boolean | null;
  video: null | {
    codec: string;
    profile?: string;
    width: number;
    height: number;
    pixFmt: string;
    fps: number;
    frames: number;
    bitrate?: number;
    durationS?: number;
    startTimeS?: number;
  };
  audio: null | {
    codec: string;
    sampleRate: number;
    channels: number;
    durationS: number;
    bitrate?: number;
    startTimeS?: number;
  };
  analysis: {
    blurMean: number | null;
    /** Sharpness edge energy (Laplacian variance on normalized 0..100 scale) when blurdetect is unavailable. */
    sharpnessScore: number | null;
    /** Brightness mean luma (0..255) from signalstats YAVG. */
    brightnessMean: number | null;
    /** Dynamic contrast spread (YMAX - YMIN or YHIGH - YLOW) from signalstats. */
    contrastSpread: number | null;
    blackSegments: Array<{ start: number; end: number }>;
    freezeSegments: Array<{ start: number; end: number }>;
    sceneCuts: number[]; // seconds
    effectiveFps: number | null; // distinct frames per second (mpdecimate)
    loudnessLufs: number | null;
    truePeakDb: number | null;
    meanVolumeDb: number | null;
    maxVolumeDb: number | null;
    rmsDb: number | null;
    /** RMS/mean level specifically in the human voice frequency band (300–3400 Hz). */
    speechBandMeanDb: number | null;
    clippedSamples: number | null;
    silenceSegments: Array<{ start: number; end: number }>;
    /** Perceptual hash (64-bit, hex) of one frame per second, for repetition detection. */
    frameHashes: string[];
  };
}

/** What the reel was supposed to be: sent by the client (no raw source media). */
export interface TimelineBeat {
  text: string;
  start_s: number;
  end_s: number;
  visual_keywords?: string;
  /** Identifier of the visual asset shown (URL without query, "source", "motion:<topic>", ...). */
  asset?: string;
  role?: 'hook' | 'context' | 'main' | 'progression' | 'cta';
  kind?: 'source' | 'broll' | 'image' | 'motion';
}

export interface TimelineWord {
  word: string;
  start_s: number;
  end_s: number;
}

export interface TimelineChunk {
  text: string;
  start_s: number;
  end_s: number;
  words: number;
  /** Lines the renderer needed for this chunk (from drawCaptionChunk's layout). */
  lines?: number;
  /** Optional individual word timings inside this caption segment. */
  wordTimings?: TimelineWord[];
}

export interface Timeline {
  durationS: number;
  scriptText: string;
  beats: TimelineBeat[];
  captions: {
    enabled: boolean;
    chunks: TimelineChunk[];
    maxLines?: number;
    /** Vertical position percentage from top (0..100); mobile safe area is roughly 58..78%. */
    positionY?: number;
    fontSize?: number;
    grouping?: 'phrase' | 'words';
  };
  audio: {
    required: boolean;
    narration: boolean;
    sourceSpeech: boolean;
    music: boolean;
    musicVolume?: number;
    /** Optional client-measured Web Audio export graph telemetry. */
    clientMeasuredPeakDb?: number;
    clientMeasuredRmsDb?: number;
  };
  /** Requested export, e.g. { width: 1080, height: 1920, fps: 30 }. */
  target?: { width: number; height: number; fps: number };
}

export interface ExportSpecReport {
  requested: { width: number; height: number; fps: number; videoCodec: string; pixFmt: string; audioCodec: string };
  actual: null | {
    width: number;
    height: number;
    fps: number;
    videoCodec: string;
    pixFmt: string;
    audioCodec: string | null;
    audioSampleRate?: number | null;
    audioChannels?: number | null;
    durationS: number;
    faststart: boolean | null;
    sizeBytes: number;
  };
  meetsSpec: boolean;
  /** Human label derived from the ACTUAL file, e.g. "1080x1920" or "512x910". */
  label: string;
}

export interface AiCreativeFinding {
  criterion: 'hook' | 'narrative_continuity' | 'visual_relevance' | 'ending_cta';
  passed: boolean;
  score: number; // 0..100
  evidence: string;
  explanation: string;
  suggestion?: string;
}

export interface AiCreativeReview {
  mode: 'ai_assisted' | 'deterministic_only';
  model?: string;
  summary: string;
  findings: AiCreativeFinding[];
}

export interface Evaluation {
  score: number;
  classification: QualityClassification;
  action: QualityAction;
  readyToPublish: boolean;
  /** True when one or more critical failures forced the reel into Poor / REJECTED regardless of numeric score. */
  criticalOverride: boolean;
  status: GateStatus;
  dimensions: DimensionResult[];
  criticalDefects: Check[];
  warnings: Check[];
  problems: Check[];
  suggestions: string[];
  recommendations: RepairRecommendation[];
  spec: ExportSpecReport;
  aiReview?: AiCreativeReview;
  notes: string[];
  evaluatedAt: string;
}
