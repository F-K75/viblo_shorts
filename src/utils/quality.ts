// Client side of the post-export & preflight quality gate (server: server/routes/quality.ts, server/lib/videoQuality/).

export type QualityStatus = 'PASS' | 'NEEDS_IMPROVEMENT' | 'REJECTED';
export type QualityClassification = 'Excellent' | 'Good' | 'Needs improvement' | 'Poor';
export type QualityAction = 'Ready to publish' | 'Ready with minor warnings' | 'Revision recommended' | 'Regeneration required';
export type TimelineKind = 'source' | 'broll' | 'image' | 'motion';

export type RepairActionType =
  | 'regenerate_voiceover'
  | 'remux_audio'
  | 'conform_encode'
  | 'rerecord_export'
  | 'enable_phrase_captions'
  | 'adjust_caption_safe_zone'
  | 'realign_captions'
  | 'diversify_visuals'
  | 'retrieve_relevant_assets'
  | 'strengthen_hook'
  | 'adjust_pacing';

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

export interface RepairRecommendation {
  id: string;
  issueId: string;
  dimension: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  autoRepairable: boolean;
  repairAction: RepairActionType;
  title: string;
  description: string;
  evidence: string;
}

export interface AiCreativeFinding {
  criterion: 'hook' | 'narrative_continuity' | 'visual_relevance' | 'ending_cta';
  score: number;
  passed: boolean;
  explanation: string;
  evidence: string;
  suggestion?: string;
}

export interface AiCreativeReview {
  mode: 'ai_assisted' | 'deterministic_only';
  model: string | null;
  findings: AiCreativeFinding[];
  summary: string;
}

export interface QualityEvaluation {
  score: number;
  classification: QualityClassification;
  action: QualityAction;
  readyToPublish: boolean;
  criticalOverride: boolean;
  status: QualityStatus;
  dimensions: Array<{ key: string; label: string; weight: number; score: number; points: number; checks: QualityCheck[] }>;
  criticalDefects: QualityCheck[];
  warnings: QualityCheck[];
  problems: QualityCheck[];
  suggestions: string[];
  recommendations: RepairRecommendation[];
  notes: string[];
  aiReview?: AiCreativeReview;
  evaluatedAt?: string;
  spec: {
    requested: { width: number; height: number; fps: number };
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
    label: string;
  };
}

export interface QualityResult {
  evaluation: QualityEvaluation;
  before: {
    score: number;
    classification?: QualityClassification;
    action?: QualityAction;
    readyToPublish?: boolean;
    status: QualityStatus;
    problems: Array<{ id: string; severity: string; message: string }>;
  };
  remediation: Array<{ action: string; ok: boolean; detail: string }>;
  downloadId: string | null;
  fileName?: string;
}

export interface RecordedExport {
  blob: Blob;
  mime: string;
  linesByChunk: Map<number, number>;
  shownByBeat: Array<{ kind: TimelineKind; asset: string } | undefined>;
  audioMetrics?: { peakDb: number; rmsDb: number; hasSignal: boolean } | null;
}

/** Report shown in the export panel. */
export interface QualityReport {
  verified: boolean;
  mode?: 'export' | 'preflight';
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
const RERECORD_IDS = new Set(['dimensions', 'duration', 'frames_present', 'video_stream', 'file_readable', 'audio_present', 'frozen_video']);
export function needsReRecord(e: QualityEvaluation): boolean {
  return e.problems.some((p) => RERECORD_IDS.has(p.id) && (p.severity === 'critical' || p.severity === 'major'));
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

/** Runs an instant server-side timeline preflight evaluation (without requiring a video upload). */
export async function runPreflightQuality(timeline: Record<string, unknown>, useAi = false): Promise<QualityEvaluation | null> {
  try {
    const resp = await fetch('/api/quality/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeline, useAi }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.evaluation ?? null;
  } catch {
    return null;
  }
}
