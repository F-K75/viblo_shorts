import {
  ALLOWED_EXPORT_AUDIO_CODECS,
  ALLOWED_EXPORT_CONTAINERS,
  ALLOWED_EXPORT_VIDEO_CODECS,
  ALLOWED_PIXEL_FORMATS,
  ALLOWED_TRANSITIONS,
  type ExportAudioCodec,
  type ExportContainer,
  type ExportPixelFormat,
  type ExportVideoCodec,
  type TransitionKind,
} from './config.ts';
import { MediaEngineError } from './exceptions.ts';

export type MediaAssetKind = 'video' | 'audio' | 'image' | 'subtitle';

export interface VideoStreamInfo {
  index: number;
  codec: string;
  profile?: string;
  width: number;
  height: number;
  pixelFormat: string;
  fps: number;
  nominalFps: number;
  avgFps: number;
  isVariableFps: boolean;
  aspectRatio: string;
  durationSeconds?: number;
  bitRate?: number;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout?: string;
  durationSeconds?: number;
  bitRate?: number;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  language?: string;
  cueCount?: number;
}

export interface MediaManifest {
  assetId: string;
  kind: MediaAssetKind;
  formatName: string;
  durationSeconds: number;
  sizeBytes: number;
  bitRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  aspectRatio: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  pixelFormat: string | null;
  isVariableFps: boolean;
  videoStreams: VideoStreamInfo[];
  audioStreams: AudioStreamInfo[];
  subtitleStreams: SubtitleStreamInfo[];
  warnings: string[];
  probedBy: 'ffprobe' | 'ffmpeg' | 'subtitle_parser';
  probedAt: string;
}

export interface MediaAssetRecord {
  id: string;
  tenantId: string;
  kind: MediaAssetKind;
  originalFilename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  storageBackend: 'local' | 's3';
  storageKey: string;
  immutable: true;
  createdAt: string;
  manifest?: MediaManifest;
}

export type PresetId =
  | 'instagram_reel'
  | 'youtube_short'
  | 'youtube_1080p'
  | 'youtube_4k'
  | 'square_social'
  | 'landscape_ad';

export type QualityProfile = 'draft' | 'standard' | 'high';

export interface ExportPreset {
  id: PresetId;
  name: string;
  aspectRatio: string;
  width: number;
  height: number;
  fps: number;
  container: ExportContainer;
  videoCodec: ExportVideoCodec;
  allowedVideoCodecs: ExportVideoCodec[];
  audioCodec: ExportAudioCodec;
  pixelFormat: ExportPixelFormat;
  videoBitrate: string;
  audioBitrate: string;
  crfByQuality: Record<QualityProfile, number>;
  ffmpegPresetByQuality: Record<QualityProfile, 'ultrafast' | 'fast' | 'medium' | 'slow'>;
  maxDurationSeconds: number;
  maxFileSizeBytes: number;
}

export interface TimelineResolution {
  width: number;
  height: number;
}

export interface TimelineVideoClip {
  id?: string;
  asset_id: string;
  start: number;
  end: number;
  source_start: number;
  source_end: number;
  transition_in?: TransitionKind;
  transition_out?: TransitionKind;
  transition_duration?: number;
  fit_mode?: 'cover' | 'contain';
  mute_source_audio?: boolean;
  volume?: number;
}

export interface TimelineImageOverlay {
  id?: string;
  asset_id: string;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
}

export interface TimelineAudioClip {
  id?: string;
  asset_id: string;
  role?: 'music' | 'voiceover' | 'sfx';
  start: number;
  end: number;
  source_start?: number;
  source_end?: number;
  volume: number;
  fade_in?: number;
  fade_out?: number;
  normalize_loudness?: boolean;
}

export interface TimelineSubtitleCue {
  id?: string;
  start: number;
  end: number;
  text: string;
}

export interface TimelineSubtitleTrack {
  id?: string;
  asset_id?: string;
  format?: 'srt' | 'vtt' | 'inline';
  burn_in?: boolean;
  font_size?: number;
  primary_color?: string;
  outline_color?: string;
  margin_v?: number;
  cues?: TimelineSubtitleCue[];
}

export interface TimelineExportSpec {
  container: ExportContainer;
  video_codec: ExportVideoCodec;
  audio_codec: ExportAudioCodec;
  pixel_format: ExportPixelFormat;
  video_bitrate: string;
  audio_bitrate?: string;
  crf?: number;
  preset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
}

export interface TimelineTracks {
  video: TimelineVideoClip[];
  audio: TimelineAudioClip[];
  subtitles: Array<TimelineSubtitleTrack | TimelineSubtitleCue>;
  overlays?: TimelineImageOverlay[];
}

export interface TimelineSpec {
  schema_version?: '1.0';
  project_id: string;
  format: PresetId;
  resolution: TimelineResolution;
  fps: number;
  /** Note: derived deterministically during validation, never blindly trusted from AI input. */
  duration_seconds: number;
  tracks: TimelineTracks;
  export: TimelineExportSpec;
}

export type QAScoreBand =
  | 'publish_ready'
  | 'minor_improvements'
  | 'revision_required'
  | 'reject_and_regenerate';

export interface QADimensionScores {
  technical_integrity: number; // max 25
  visual_quality: number; // max 25
  audio_quality: number; // max 20
  editing_quality: number; // max 20
  creative_compliance: number; // max 10
}

export interface QAMetrics {
  black_frame_intervals: Array<{ start: number; end: number; duration: number }>;
  total_black_duration: number;
  freeze_intervals: Array<{ start: number; end: number; duration: number }>;
  total_freeze_duration: number;
  audio_peak_db: number | null;
  audio_rms_db: number | null;
  audio_clipping_detected: boolean;
  audio_silent_detected: boolean;
  decode_errors: number;
  expected_duration_seconds: number;
  actual_duration_seconds: number;
  duration_drift_seconds: number;
  av_sync_drift_seconds: number;
  subtitle_timing_errors: number;
}

export interface QAReport {
  job_id: string;
  project_id: string;
  artifact_id?: string;
  total_score: number;
  band: QAScoreBand;
  passed: boolean;
  revision_required: boolean;
  dimensions: QADimensionScores;
  metrics: QAMetrics;
  warnings: string[];
  failures: string[];
  repair_actions: string[];
  evaluated_at: string;
}

export interface MediaProjectRecord {
  id: string;
  tenantId: string;
  title: string;
  brief: string;
  format: PresetId;
  assetIds: string[];
  timeline: TimelineSpec | null;
  timelineVersion: number;
  editPlan?: Record<string, unknown>;
  audioMixPlan?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type MediaJobStage =
  | 'initializing'
  | 'validating_assets'
  | 'probing'
  | 'planning_timeline'
  | 'validating_timeline'
  | 'encoding'
  | 'validating_output'
  | 'evaluating_qa'
  | 'repairing'
  | 'publishing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MediaArtifactRecord {
  id: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  kind: 'video' | 'audio' | 'thumbnail' | 'subtitles';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageBackend: 'local' | 's3';
  storageKey: string;
  downloadUrl: string;
  durationSeconds: number;
  resolution: string;
  codec: string;
  qaScore: number;
  qaReport?: QAReport;
  createdAt: string;
}

export type MediaEventType =
  | 'media.asset.uploaded'
  | 'media.asset.probed'
  | 'media.project.created'
  | 'media.timeline.updated'
  | 'media.render.queued'
  | 'media.render.started'
  | 'media.render.progress'
  | 'media.render.completed'
  | 'media.render.failed'
  | 'media.qa.started'
  | 'media.qa.completed'
  | 'media.artifact.published'
  | 'media.job.cancelled';

export interface MediaEvent {
  event_id: string;
  event_type: MediaEventType;
  schema_version: '1.0';
  tenant_id: string;
  project_id: string;
  job_id?: string;
  correlation_id: string;
  timestamp: string;
  progress?: number;
  stage?: MediaJobStage;
  payload?: Record<string, unknown>;
}

/** Exact Section 9 output contract for completed media production jobs. */
export interface RenderOutputContract {
  status: 'completed' | 'failed' | 'cancelled';
  artifact_id: string | null;
  preview_url?: string | null;
  duration_seconds: number;
  resolution: string;
  codec: string;
  qa_score: number;
  warnings: string[];
  revision_required: boolean;
  qa_report?: QAReport;
}

const ASSET_ID_RE = /^asset_[a-f0-9]{32}$/;
const PROJECT_ID_RE = /^(?:mproj_[a-f0-9]{24}|media_[A-Za-z0-9_-]{1,64}|proj_[A-Za-z0-9_-]{1,64})$/;
const ARTIFACT_ID_RE = /^artifact_[a-f0-9]{32}$/;
const MEDIA_JOB_ID_RE = /^(?:render_[a-f0-9]{16,32}|mjob_[a-f0-9]{24}|job_[0-9]+_[a-f0-9]{10})$/;
const BITRATE_RE = /^\d+(?:\.\d+)?[kKmM]$/;

export const isValidAssetId = (id: unknown): id is string => typeof id === 'string' && ASSET_ID_RE.test(id);
export const isValidMediaProjectId = (id: unknown): id is string => typeof id === 'string' && PROJECT_ID_RE.test(id);
export const isValidArtifactId = (id: unknown): id is string => typeof id === 'string' && ARTIFACT_ID_RE.test(id);
export const isValidMediaJobId = (id: unknown): id is string => typeof id === 'string' && MEDIA_JOB_ID_RE.test(id);

function assertFiniteNumber(val: unknown, field: string, min?: number, max?: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new MediaEngineError('TIMELINE_ERROR', `${field} must be a finite number`, { details: { field, value: val } });
  }
  if (min !== undefined && val < min) {
    throw new MediaEngineError('TIMELINE_ERROR', `${field} (${val}) must be >= ${min}`, { details: { field, value: val, min } });
  }
  if (max !== undefined && val > max) {
    throw new MediaEngineError('TIMELINE_ERROR', `${field} (${val}) must be <= ${max}`, { details: { field, value: val, max } });
  }
  return val;
}

function assertEnum<T extends string>(val: unknown, allowed: readonly T[], field: string, code: 'TIMELINE_ERROR' | 'UNSUPPORTED_CODEC' = 'TIMELINE_ERROR'): T {
  if (typeof val !== 'string' || !(allowed as readonly string[]).includes(val)) {
    throw new MediaEngineError(code, `Unsupported ${field}: ${String(val)}. Allowed: ${allowed.join(', ')}`, {
      details: { field, value: val, allowed },
    });
  }
  return val as T;
}

/**
 * Runtime structural validator for TimelineSpec (TypeScript equivalent of Pydantic validation).
 * Enforces field types, timestamp bounds, codec allowlists, and opaque asset IDs before timeline semantics run.
 */
export function parseTimelineSchema(raw: unknown): TimelineSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MediaEngineError('TIMELINE_ERROR', 'Timeline must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  if (!isValidMediaProjectId(obj.project_id)) {
    throw new MediaEngineError('TIMELINE_ERROR', `Invalid project_id: ${String(obj.project_id)}`);
  }

  const allowedFormats: readonly PresetId[] = [
    'instagram_reel',
    'youtube_short',
    'youtube_1080p',
    'youtube_4k',
    'square_social',
    'landscape_ad',
  ];
  const format = assertEnum(obj.format, allowedFormats, 'format');

  if (!obj.resolution || typeof obj.resolution !== 'object') {
    throw new MediaEngineError('TIMELINE_ERROR', 'resolution must be an object with width and height');
  }
  const resObj = obj.resolution as Record<string, unknown>;
  const width = Math.round(assertFiniteNumber(resObj.width, 'resolution.width', 128, 3840));
  const height = Math.round(assertFiniteNumber(resObj.height, 'resolution.height', 128, 3840));
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new MediaEngineError('TIMELINE_ERROR', 'resolution.width and resolution.height must be even integers for yuv420p');
  }

  const fps = assertFiniteNumber(obj.fps, 'fps', 1, 120);
  const declaredDuration = obj.duration_seconds !== undefined ? assertFiniteNumber(obj.duration_seconds, 'duration_seconds', 0, 3600) : 0;

  if (!obj.tracks || typeof obj.tracks !== 'object' || Array.isArray(obj.tracks)) {
    throw new MediaEngineError('TIMELINE_ERROR', 'tracks must be an object containing video, audio, and subtitles arrays');
  }
  const tracksObj = obj.tracks as Record<string, unknown>;
  if (!Array.isArray(tracksObj.video)) {
    throw new MediaEngineError('TIMELINE_ERROR', 'tracks.video must be an array');
  }
  if (!Array.isArray(tracksObj.audio)) {
    throw new MediaEngineError('TIMELINE_ERROR', 'tracks.audio must be an array');
  }
  if (tracksObj.subtitles !== undefined && !Array.isArray(tracksObj.subtitles)) {
    throw new MediaEngineError('TIMELINE_ERROR', 'tracks.subtitles must be an array');
  }
  if (tracksObj.overlays !== undefined && !Array.isArray(tracksObj.overlays)) {
    throw new MediaEngineError('TIMELINE_ERROR', 'tracks.overlays must be an array');
  }

  const video: TimelineVideoClip[] = tracksObj.video.map((c: unknown, idx: number) => {
    if (!c || typeof c !== 'object') {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.video[${idx}] must be an object`);
    }
    const clip = c as Record<string, unknown>;
    if (!isValidAssetId(clip.asset_id)) {
      throw new MediaEngineError('ASSET_ERROR', `tracks.video[${idx}].asset_id is not a valid authorized asset ID`);
    }
    const start = assertFiniteNumber(clip.start, `tracks.video[${idx}].start`, 0, 3600);
    const end = assertFiniteNumber(clip.end, `tracks.video[${idx}].end`, 0, 3600);
    if (end <= start) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.video[${idx}].end (${end}) must be greater than start (${start})`);
    }
    const source_start = assertFiniteNumber(clip.source_start ?? 0, `tracks.video[${idx}].source_start`, 0, 36_000);
    const source_end = assertFiniteNumber(
      clip.source_end ?? source_start + (end - start),
      `tracks.video[${idx}].source_end`,
      0,
      36_000,
    );
    if (source_end <= source_start) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.video[${idx}].source_end (${source_end}) must be greater than source_start (${source_start})`);
    }
    const transition_in = clip.transition_in !== undefined ? assertEnum(clip.transition_in, ALLOWED_TRANSITIONS, `tracks.video[${idx}].transition_in`) : undefined;
    const transition_out = clip.transition_out !== undefined ? assertEnum(clip.transition_out, ALLOWED_TRANSITIONS, `tracks.video[${idx}].transition_out`) : undefined;
    const transition_duration = clip.transition_duration !== undefined ? assertFiniteNumber(clip.transition_duration, `tracks.video[${idx}].transition_duration`, 0.05, 5) : undefined;
    const fit_mode = clip.fit_mode !== undefined ? assertEnum(clip.fit_mode, ['cover', 'contain'] as const, `tracks.video[${idx}].fit_mode`) : 'cover';
    const volume = clip.volume !== undefined ? assertFiniteNumber(clip.volume, `tracks.video[${idx}].volume`, 0, 4) : 1;

    return {
      ...(typeof clip.id === 'string' ? { id: clip.id.slice(0, 64) } : {}),
      asset_id: clip.asset_id,
      start,
      end,
      source_start,
      source_end,
      ...(transition_in ? { transition_in } : {}),
      ...(transition_out ? { transition_out } : {}),
      ...(transition_duration !== undefined ? { transition_duration } : {}),
      fit_mode,
      mute_source_audio: Boolean(clip.mute_source_audio),
      volume,
    };
  });

  const audio: TimelineAudioClip[] = tracksObj.audio.map((a: unknown, idx: number) => {
    if (!a || typeof a !== 'object') {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.audio[${idx}] must be an object`);
    }
    const track = a as Record<string, unknown>;
    if (!isValidAssetId(track.asset_id)) {
      throw new MediaEngineError('ASSET_ERROR', `tracks.audio[${idx}].asset_id is not a valid authorized asset ID`);
    }
    const start = assertFiniteNumber(track.start, `tracks.audio[${idx}].start`, 0, 3600);
    const end = assertFiniteNumber(track.end, `tracks.audio[${idx}].end`, 0, 3600);
    if (end <= start) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.audio[${idx}].end (${end}) must be greater than start (${start})`);
    }
    const volume = assertFiniteNumber(track.volume, `tracks.audio[${idx}].volume`, 0, 4);
    const source_start = track.source_start !== undefined ? assertFiniteNumber(track.source_start, `tracks.audio[${idx}].source_start`, 0, 36_000) : 0;
    const source_end = track.source_end !== undefined ? assertFiniteNumber(track.source_end, `tracks.audio[${idx}].source_end`, 0, 36_000) : undefined;
    if (source_end !== undefined && source_end <= source_start) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.audio[${idx}].source_end must be greater than source_start`);
    }
    const fade_in = track.fade_in !== undefined ? assertFiniteNumber(track.fade_in, `tracks.audio[${idx}].fade_in`, 0, 30) : undefined;
    const fade_out = track.fade_out !== undefined ? assertFiniteNumber(track.fade_out, `tracks.audio[${idx}].fade_out`, 0, 30) : undefined;
    const role = track.role !== undefined ? assertEnum(track.role, ['music', 'voiceover', 'sfx'] as const, `tracks.audio[${idx}].role`) : undefined;

    return {
      ...(typeof track.id === 'string' ? { id: track.id.slice(0, 64) } : {}),
      asset_id: track.asset_id,
      ...(role ? { role } : {}),
      start,
      end,
      source_start,
      ...(source_end !== undefined ? { source_end } : {}),
      volume,
      ...(fade_in !== undefined ? { fade_in } : {}),
      ...(fade_out !== undefined ? { fade_out } : {}),
      ...(track.normalize_loudness !== undefined ? { normalize_loudness: Boolean(track.normalize_loudness) } : {}),
    };
  });

  const rawSubs = Array.isArray(tracksObj.subtitles) ? tracksObj.subtitles : [];
  const subtitles: Array<TimelineSubtitleTrack | TimelineSubtitleCue> = rawSubs.map((s: unknown, idx: number) => {
    if (!s || typeof s !== 'object') {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}] must be an object`);
    }
    const item = s as Record<string, unknown>;
    if (typeof item.text === 'string') {
      const start = assertFiniteNumber(item.start, `tracks.subtitles[${idx}].start`, 0, 3600);
      const end = assertFiniteNumber(item.end, `tracks.subtitles[${idx}].end`, 0, 3600);
      if (end <= start) {
        throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}].end must be greater than start`);
      }
      const text = item.text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300);
      if (!text) {
        throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}].text must not be empty`);
      }
      return {
        ...(typeof item.id === 'string' ? { id: item.id.slice(0, 64) } : {}),
        start,
        end,
        text,
      };
    }
    if (item.asset_id !== undefined && !isValidAssetId(item.asset_id)) {
      throw new MediaEngineError('ASSET_ERROR', `tracks.subtitles[${idx}].asset_id is not a valid authorized asset ID`);
    }
    const cues = Array.isArray(item.cues)
      ? item.cues.map((c: unknown, cIdx: number) => {
          if (!c || typeof c !== 'object') {
            throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}].cues[${cIdx}] must be an object`);
          }
          const cue = c as Record<string, unknown>;
          const start = assertFiniteNumber(cue.start, `tracks.subtitles[${idx}].cues[${cIdx}].start`, 0, 3600);
          const end = assertFiniteNumber(cue.end, `tracks.subtitles[${idx}].cues[${cIdx}].end`, 0, 3600);
          if (end <= start) {
            throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}].cues[${cIdx}].end must be > start`);
          }
          const text = String(cue.text ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300);
          if (!text) {
            throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}].cues[${cIdx}].text must not be empty`);
          }
          return { start, end, text };
        })
      : undefined;

    if (!item.asset_id && (!cues || cues.length === 0)) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${idx}] must specify either asset_id or non-empty cues`);
    }

    return {
      ...(typeof item.id === 'string' ? { id: item.id.slice(0, 64) } : {}),
      ...(typeof item.asset_id === 'string' ? { asset_id: item.asset_id } : {}),
      format: item.format !== undefined ? assertEnum(item.format, ['srt', 'vtt', 'inline'] as const, `tracks.subtitles[${idx}].format`) : 'srt',
      burn_in: item.burn_in !== undefined ? Boolean(item.burn_in) : true,
      ...(item.font_size !== undefined ? { font_size: assertFiniteNumber(item.font_size, `tracks.subtitles[${idx}].font_size`, 10, 120) } : {}),
      ...(item.margin_v !== undefined ? { margin_v: assertFiniteNumber(item.margin_v, `tracks.subtitles[${idx}].margin_v`, 0, 800) } : {}),
      ...(cues ? { cues } : {}),
    };
  });

  const overlays: TimelineImageOverlay[] | undefined = Array.isArray(tracksObj.overlays)
    ? tracksObj.overlays.map((o: unknown, idx: number) => {
        if (!o || typeof o !== 'object') {
          throw new MediaEngineError('TIMELINE_ERROR', `tracks.overlays[${idx}] must be an object`);
        }
        const ov = o as Record<string, unknown>;
        if (!isValidAssetId(ov.asset_id)) {
          throw new MediaEngineError('ASSET_ERROR', `tracks.overlays[${idx}].asset_id is not a valid authorized asset ID`);
        }
        const start = assertFiniteNumber(ov.start, `tracks.overlays[${idx}].start`, 0, 3600);
        const end = assertFiniteNumber(ov.end, `tracks.overlays[${idx}].end`, 0, 3600);
        if (end <= start) {
          throw new MediaEngineError('TIMELINE_ERROR', `tracks.overlays[${idx}].end must be > start`);
        }
        return {
          asset_id: ov.asset_id,
          start,
          end,
          x: Math.round(assertFiniteNumber(ov.x ?? 0, `tracks.overlays[${idx}].x`, 0, 3840)),
          y: Math.round(assertFiniteNumber(ov.y ?? 0, `tracks.overlays[${idx}].y`, 0, 3840)),
          width: Math.round(assertFiniteNumber(ov.width ?? 200, `tracks.overlays[${idx}].width`, 16, 3840)),
          height: Math.round(assertFiniteNumber(ov.height ?? 200, `tracks.overlays[${idx}].height`, 16, 3840)),
          opacity: ov.opacity !== undefined ? assertFiniteNumber(ov.opacity, `tracks.overlays[${idx}].opacity`, 0.05, 1) : 1,
        };
      })
    : undefined;

  if (!obj.export || typeof obj.export !== 'object') {
    throw new MediaEngineError('TIMELINE_ERROR', 'export configuration object is required');
  }
  const exp = obj.export as Record<string, unknown>;
  const container = assertEnum(exp.container, ALLOWED_EXPORT_CONTAINERS, 'export.container', 'UNSUPPORTED_CODEC');
  const video_codec = assertEnum(exp.video_codec, ALLOWED_EXPORT_VIDEO_CODECS, 'export.video_codec', 'UNSUPPORTED_CODEC');
  const audio_codec = assertEnum(exp.audio_codec, ALLOWED_EXPORT_AUDIO_CODECS, 'export.audio_codec', 'UNSUPPORTED_CODEC');
  const pixel_format = assertEnum(exp.pixel_format, ALLOWED_PIXEL_FORMATS, 'export.pixel_format', 'UNSUPPORTED_CODEC');
  const video_bitrate = typeof exp.video_bitrate === 'string' && BITRATE_RE.test(exp.video_bitrate) ? exp.video_bitrate : null;
  if (!video_bitrate) {
    throw new MediaEngineError('TIMELINE_ERROR', `Invalid export.video_bitrate: ${String(exp.video_bitrate)} (expected e.g. "8M" or "4500k")`);
  }
  const audio_bitrate =
    exp.audio_bitrate !== undefined
      ? typeof exp.audio_bitrate === 'string' && BITRATE_RE.test(exp.audio_bitrate)
        ? exp.audio_bitrate
        : (() => {
            throw new MediaEngineError('TIMELINE_ERROR', `Invalid export.audio_bitrate: ${String(exp.audio_bitrate)}`);
          })()
      : '192k';

  const crf = exp.crf !== undefined ? Math.round(assertFiniteNumber(exp.crf, 'export.crf', 10, 40)) : undefined;
  const preset =
    exp.preset !== undefined
      ? assertEnum(exp.preset, ['ultrafast', 'fast', 'medium', 'slow'] as const, 'export.preset')
      : undefined;

  return {
    schema_version: '1.0',
    project_id: obj.project_id,
    format,
    resolution: { width, height },
    fps,
    duration_seconds: declaredDuration,
    tracks: {
      video,
      audio,
      subtitles,
      ...(overlays ? { overlays } : {}),
    },
    export: {
      container,
      video_codec,
      audio_codec,
      pixel_format,
      video_bitrate,
      audio_bitrate,
      ...(crf !== undefined ? { crf } : {}),
      ...(preset ? { preset } : {}),
    },
  };
}
