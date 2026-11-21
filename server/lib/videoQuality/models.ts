// Types shared by the video quality evaluation engine. Every check carries the evidence it was decided on.

export type Severity = 'info' | 'minor' | 'major' | 'critical';
/** Legacy gate status, kept for API compatibility: PASS = Excellent/Good, NEEDS_IMPROVEMENT, REJECTED = Poor. */
export type GateStatus = 'PASS' | 'NEEDS_IMPROVEMENT' | 'REJECTED';
export type Classification = 'EXCELLENT' | 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR';
export type DimensionKey = 'audio' | 'export' | 'visual' | 'captions' | 'story' | 'pacing' | 'technical';

/** What to do about a failed check. `automatic` repairs are deterministic and safe; the rest need the creator. */
export type RepairAction =
  | 'remux_conform' // re-encode container/codec/fps/pixel format/faststart/loudness (server, automatic)
  | 'rerecord' // record the timeline again (client, automatic, at most MAX_REMEDIATION times)
  | 'regenerate_voiceover' // fetch narration again / switch to a recordable voice
  | 'attach_source' // the clip needs the creator's own copy of the video (footage + speech)
  | 'realign_captions' // re-time captions to the voice track
  | 'regroup_captions' // phrase grouping / line limits
  | 'reposition_captions' // move captions inside the safe area / off the subject
  | 'replace_scenes' // repetitive or static visuals: new footage per scene
  | 'retrieve_assets' // visuals unrelated to narration / low resolution source
  | 'strengthen_hook'
  | 'adjust_pacing'
  | 'improve_ending'
  | 'rerender_resolution';

export interface Recommendation {
  action: RepairAction;
  /** Plain-language instruction for the creator. */
  title: string;
  detail: string;
  automatic: boolean;
  /** Check ids this addresses. */
  checks: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
}

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
    /** Decoded-signal facts (a stream that exists but carries zeros is NOT audio). Null when there is no audio. */
    audioSignal: null | {
      peakDb: number | null; // null = -inf (digital silence)
      rmsDb: number | null;
      digitalSilence: boolean;
      activeSpans: Array<{ start: number; end: number }>;
      activeRatio: number;
      speechSpans: Array<{ start: number; end: number }>;
      speechRatio: number;
      modulationIndex: number;
      method: string;
    };
    /** Real detail in the frames: a small image upscaled to 1080x1920 survives a down/up round trip unchanged. */
    detail: null | { psnrByFactor: Record<string, number>; effectiveFactor: number; effectiveWidth: number; effectiveHeight: number; frames: number };
    /** Visual states from 2 fps thumbnails: a slow zoom on one still is ONE state, not 30 distinct frames. */
    stability: null | {
      states: Array<{ start: number; end: number; cluster: number }>;
      distinctVisuals: number;
      longestStaticS: number;
      meanLuma: number; // 0..255
      contrast: number; // std-dev of luma, 0..~128
      darkRatio: number; // share of sampled frames with mean luma < 25
    };
    /** Container timestamps. */
    timing: null | {
      videoStartS: number;
      audioStartS: number | null;
      declaredFps: number;
      packets: number;
      nonMonotonicDts: number;
      maxFrameGapS: number;
      frameIntervalJitterMs: number;
    };
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
  captions: {
    enabled: boolean;
    chunks: TimelineChunk[];
    maxLines?: number;
    /** How word times were obtained: aligned to the real voice, the speaker's transcript times, or an estimate. */
    wordTiming?: 'aligned' | 'transcript' | 'estimated';
    /** Word-level timings used for the active-word highlight (start/end seconds, in reel time). */
    words?: Array<{ start_s: number; end_s: number }>;
    /** Caption box as drawn, as fractions of the frame (worst case over the reel). */
    box?: { top: number; bottom: number; left: number; right: number };
    /** Share of caption time during which the box covered the detected subject (skin/face region), 0..1. */
    subjectOverlap?: number;
    /** Whether captions are REQUIRED for this reel (default: when enabled). */
    required?: boolean;
  };
  audio: {
    required: boolean;
    narration: boolean;
    sourceSpeech: boolean;
    music: boolean;
    musicVolume?: number;
    /**
     * Is there spoken content (a voiceover script or a speaker's transcript) the viewer is supposed to HEAR?
     * Captions of a speech clip imply yes even when nothing recordable plays it.
     */
    speechExpected?: boolean;
    /**
     * Where the speech in the export comes from. 'neural' / 'offline' TTS and 'source-file' are recorded into the
     * file; 'youtube-embed' and 'browser-tts' play in the page but CANNOT be recorded; 'none' = nothing speaks.
     */
    /** The creator explicitly asked for a silent reel. Only this exempts a reel from the silent-audio failure. */
    silentIntended?: boolean;
    speechSource?: 'neural-tts' | 'offline-tts' | 'source-file' | 'youtube-embed' | 'browser-tts' | 'none';
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
    durationS: number;
    faststart: boolean | null;
    sizeBytes: number;
  };
  meetsSpec: boolean;
  /** Human label derived from the ACTUAL file, e.g. "1080x1920" or "512x910". */
  label: string;
}

export interface AiReview {
  model: string;
  /** Per-criterion judgement with the script/scene evidence it relies on (quotes verified against the script). */
  criteria: Array<{ id: string; score: number; verdict: string; evidence: string[]; suggestion?: string; evidenceVerified: boolean }>;
  summary: string;
}

export interface Evaluation {
  score: number;
  /** Excellent (90+) / Good (80+) / Needs improvement (70+) / Poor; any critical defect forces POOR. */
  classification: Classification;
  /** 'Ready to publish' / 'Ready with minor warnings' / 'Revision recommended' / 'Regeneration required'. */
  action: string;
  readyToPublish: boolean;
  status: GateStatus;
  recommendations: Recommendation[];
  /** Present when the AI judge ran (subjective storytelling); absent when unavailable (see notes). */
  aiReview?: AiReview;
  dimensions: DimensionResult[];
  criticalDefects: Check[];
  problems: Check[];
  suggestions: string[];
  spec: ExportSpecReport;
  notes: string[];
  evaluatedAt: string;
}
