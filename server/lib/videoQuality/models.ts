// Types shared by the video quality evaluation engine. Every check carries the evidence it was decided on.

export type Severity = 'info' | 'minor' | 'major' | 'critical';
export type GateStatus = 'PASS' | 'NEEDS_IMPROVEMENT' | 'REJECTED';
export type DimensionKey = 'captions' | 'visual' | 'diversity' | 'story' | 'audio' | 'editing' | 'export';

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
  };
  audio: null | { codec: string; sampleRate: number; channels: number; durationS: number };
  analysis: {
    blurMean: number | null;
    blackSegments: Array<{ start: number; end: number }>;
    freezeSegments: Array<{ start: number; end: number }>;
    sceneCuts: number[]; // seconds
    effectiveFps: number | null; // distinct frames per second (mpdecimate)
    loudnessLufs: number | null;
    truePeakDb: number | null;
    meanVolumeDb: number | null;
    clippedSamples: number | null;
    silenceSegments: Array<{ start: number; end: number }>;
    /** Perceptual hash (64-bit, hex) of one frame per second, for repetition detection. */
    frameHashes: string[];
  };
}

/** What the reel was supposed to be: sent by the client (no media). */
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

export interface TimelineChunk {
  text: string;
  start_s: number;
  end_s: number;
  words: number;
  /** Lines the renderer needed for this chunk (from drawCaptionChunk's layout). */
  lines?: number;
}

export interface Timeline {
  durationS: number;
  scriptText: string;
  beats: TimelineBeat[];
  captions: { enabled: boolean; chunks: TimelineChunk[]; maxLines?: number };
  audio: { required: boolean; narration: boolean; sourceSpeech: boolean; music: boolean; musicVolume?: number };
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
    durationS: number;
    faststart: boolean | null;
    sizeBytes: number;
  };
  meetsSpec: boolean;
  /** Human label derived from the ACTUAL file, e.g. "1080x1920" or "512x910". */
  label: string;
}

export interface Evaluation {
  score: number;
  status: GateStatus;
  dimensions: DimensionResult[];
  criticalDefects: Check[];
  problems: Check[];
  suggestions: string[];
  spec: ExportSpecReport;
  notes: string[];
  evaluatedAt: string;
}
