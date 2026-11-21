// Client side of the post-export quality gate (server: server/routes/quality.ts, server/lib/videoQuality/).

export type QualityStatus = 'PASS' | 'NEEDS_IMPROVEMENT' | 'REJECTED';
export type QualityClassification = 'EXCELLENT' | 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR';
export type RepairAction =
  | 'remux_conform' | 'rerecord' | 'regenerate_voiceover' | 'attach_source' | 'realign_captions' | 'regroup_captions'
  | 'reposition_captions' | 'replace_scenes' | 'retrieve_assets' | 'strengthen_hook' | 'adjust_pacing' | 'improve_ending'
  | 'rerender_resolution';
export interface QualityRecommendation {
  action: RepairAction;
  title: string;
  detail: string;
  automatic: boolean;
  checks: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
}
export type SpeechSource = 'neural-tts' | 'offline-tts' | 'source-file' | 'youtube-embed' | 'browser-tts' | 'none';
export type TimelineKind = 'source' | 'broll' | 'image' | 'motion';

export interface QualityCheck {
  id: string;
  dimension: string;
  passed: boolean;
  severity: 'info' | 'minor' | 'major' | 'critical';
  message: string;
  suggestion?: string;
  measured?: boolean;
  evidence: Record<string, unknown>;
}

export interface QualityEvaluation {
  score: number;
  classification: QualityClassification;
  action: string;
  readyToPublish: boolean;
  recommendations: QualityRecommendation[];
  aiReview?: { model: string; summary: string; criteria: Array<{ id: string; score: number; verdict: string; evidence: string[]; evidenceVerified: boolean; suggestion?: string }> };
  status: QualityStatus;
  dimensions: Array<{ key: string; label: string; weight: number; score: number; points: number; checks: QualityCheck[] }>;
  criticalDefects: QualityCheck[];
  problems: QualityCheck[];
  suggestions: string[];
  notes: string[];
  spec: {
    requested: { width: number; height: number; fps: number };
    actual: null | { width: number; height: number; fps: number; videoCodec: string; pixFmt: string; audioCodec: string | null; durationS: number; faststart: boolean | null; sizeBytes: number };
    meetsSpec: boolean;
    label: string;
  };
}

export interface QualityResult {
  evaluation: QualityEvaluation;
  before: { score: number; status: QualityStatus; problems: Array<{ id: string; severity: string; message: string }> };
  remediation: Array<{ action: string; ok: boolean; detail: string }>;
  downloadId: string | null;
  fileName?: string;
  retry?: { evaluation: number; maxEvaluations: number };
}

export interface RecordedExport {
  blob: Blob;
  mime: string;
  linesByChunk: Map<number, number>;
  shownByBeat: Array<{ kind: TimelineKind; asset: string } | undefined>;
  /** Union of every caption box drawn, as fractions of the frame. */
  captionBox?: { top: number; bottom: number; left: number; right: number };
  /** Share of caption time the box covered the detected subject. */
  subjectOverlap?: number;
  /** What the recorder actually received on its audio track (metered live). */
  meter?: { peakDb: number | null; activeRatio: number };
  /** Narration lines that had no recordable voice. */
  narrationMissing?: string[];
}

/** Report shown in the export panel. */
export interface QualityReport {
  /** 'precheck' = the plan was checked before rendering (nothing recorded yet). */
  phase?: 'precheck' | 'final';
  verified: boolean;
  result?: QualityResult;
  error?: string;
  attempts: string[];
  fileName: string;
  local?: { width: number; height: number } | null;
  delivered: boolean;
}

/** Re-recording is attempted at most this many times (each costs one real-time recording, no AI calls). */
export const MAX_REMEDIATION = 1;

/** Encoder preference per attempt: H.264 first (fastest real-time encoder), then a different encoder path. */
export const MIME_ORDERS: string[][] = [
  ['video/mp4;codecs=avc1.42E028,mp4a.40.2', 'video/mp4;codecs=avc1.42E028', 'video/mp4;codecs=avc1', 'video/webm;codecs=h264,opus', 'video/webm;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'],
  ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=avc1.42E028,mp4a.40.2', 'video/mp4'],
];

/** Defects a new recording can fix (the encoder/recorder misbehaved), as opposed to content defects. */
const RERECORD_IDS = new Set(['dimensions', 'duration', 'frames_present', 'video_stream', 'file_readable', 'file_integrity', 'audio_signal', 'audio_stream', 'frozen_video', 'frame_gaps', 'av_duration']);
export function needsReRecord(e: QualityEvaluation): boolean {
  // A content problem (e.g. an unrecordable voice) is not fixed by recording again: never loop on it.
  if (e.problems.some((p) => p.id === 'speech_source' && !p.passed)) return false;
  return e.problems.some((p) => RERECORD_IDS.has(p.id) && (p.severity === 'critical' || p.severity === 'major'));
}

/** Plain-language names for checks, for creators (the technical message stays available as evidence). */
export const CHECK_TITLES: Record<string, string> = {
  speech_source: 'The voice cannot be recorded',
  audio_stream: 'No sound track',
  audio_signal: 'The video is silent',
  speech_presence: 'No voice heard',
  voiceover_completeness: 'Parts of the voiceover are missing',
  rms_level: 'Sound is too quiet',
  loudness: 'Loudness off target',
  clipping: 'Sound distorts (clipping)',
  speech_music_balance: 'Music may drown the voice',
  dimensions: 'Wrong video size',
  aspect_ratio: 'Not vertical 9:16',
  video_codec: 'Video format',
  pixel_format: 'Colour format',
  frame_rate: 'Frame rate',
  audio_codec: 'Audio format',
  faststart: 'Slow to start on the web',
  duration: 'Length differs from the timeline',
  file_readable: 'The file is damaged',
  file_integrity: 'The file is incomplete',
  video_stream: 'No picture',
  frames_present: 'No picture',
  render_resolution: 'Rendered too small',
  effective_detail: 'Picture is blurry (stretched from a small image)',
  sharpness: 'Picture is soft',
  black_frames: 'Black screens',
  frozen_video: 'Video freezes',
  dropped_frames: 'Choppy motion',
  static_visuals: 'The picture barely changes',
  scene_diversity: 'Too few different visuals',
  repeated_shots: 'The same shot repeats',
  asset_reuse: 'The same footage is reused',
  scenes_rendered: 'Scenes are missing',
  subject_clear: 'Captions cover the speaker',
  exposure: 'Too dark or too bright',
  contrast: 'Flat, low-contrast picture',
  present: 'Captions are missing',
  coverage: 'Captions skip words',
  overlaps: 'Captions overlap',
  timing_range: 'Captions outside the video',
  readable_duration: 'Captions flash too fast',
  fragments: 'Captions break phrases apart',
  orphans: 'Single-word captions',
  overflow: 'Captions too long for the screen',
  safe_area: 'Captions under the YouTube buttons/title',
  word_timing: 'Word timing is estimated',
  highlight_sync: 'Highlighted word out of sync',
  sync_start: 'Captions start at the wrong time',
  sync_silence: 'Captions shown during silence',
  speech_captioned: 'Speech without captions',
  hook: 'Weak or slow opening',
  structure: 'Story structure',
  progression: 'Scenes repeat the same point',
  visual_progression: "Visuals don't follow the story",
  ending: 'Weak ending',
  cta: 'No call to action',
  relevance: "Visuals don't match the words",
  shot_pacing: 'Pacing of cuts',
  shot_length: 'A scene runs too long',
  speech_rate: 'Speaking pace',
  dead_air: 'Long silent gaps',
  continuity: 'Black gaps between scenes',
  av_duration: 'Sound and picture lengths differ',
  av_start_offset: 'Sound and picture start apart',
  av_sync: 'Voice out of sync',
  audio_format: 'Audio sample rate',
  timestamps: 'Corrupt timestamps',
  frame_gaps: 'Recording stalled',
  constant_frame_rate: 'Uneven frame timing',
  caption_bounds: 'Captions run past the end',
};
export const titleFor = (id: string) => CHECK_TITLES[id] || (id.startsWith('ai_') ? `AI review: ${id.slice(3)}` : id.replace(/_/g, ' '));

/** Compact, readable evidence lines (numbers and short values only; long arrays summarised). */
export function evidenceLines(evidence: Record<string, unknown>, max = 6): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(evidence || {})) {
    if (out.length >= max) break;
    if (v === null || v === undefined) continue;
    const label = k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase();
    if (Array.isArray(v)) out.push(`${label}: ${v.length ? JSON.stringify(v.slice(0, 3)).slice(0, 120) + (v.length > 3 ? ` (+${v.length - 3})` : '') : 'none'}`);
    else if (typeof v === 'object') out.push(`${label}: ${JSON.stringify(v).slice(0, 120)}`);
    else out.push(`${label}: ${String(v).slice(0, 120)}`);
  }
  return out;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000); // revoking immediately can cancel the download
}

/** Reads the real frame size of a recording in the browser (used only when the server check is unavailable). */
export function measureBlob(blob: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = (r: { width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    v.src = url;
  });
}
