// Versioned edit instructions for the first vertical Reel workflow. An edit plan
// names assets by ID. A separate execution boundary must verify ownership,
// source duration and stream availability against the stored assets.

export const MEDIA_TIMELINE_PRESETS = Object.freeze({
  'vertical-720p': Object.freeze({ width: 720, height: 1280, fps: 30 }),
  'vertical-1080p': Object.freeze({ width: 1080, height: 1920, fps: 30 }),
});

export const MEDIA_TIMELINE_LIMITS = Object.freeze({
  durationMs: 60_000,
  sourceTimestampMs: 24 * 60 * 60 * 1000,
  videoClips: 5,
  captionCues: 100,
  captionLength: 160,
});

declare const assetIdBrand: unique symbol;
export type AssetId = string & { readonly [assetIdBrand]: true };
export type MediaTimelinePreset = keyof typeof MEDIA_TIMELINE_PRESETS;

interface TimelineRange {
  readonly startMs: number;
  readonly endMs: number;
}

export interface TimelineAssetWindow extends TimelineRange {
  readonly assetId: AssetId;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
}

export interface TimelineCaptionCue extends TimelineRange {
  readonly text: string;
}

export interface TimelineMusicTrack extends TimelineAssetWindow {
  /** Linear gain in [0, 1]. */
  readonly gain: number;
}

export interface MediaTimelineV1 {
  readonly schemaVersion: '1.0';
  readonly preset: MediaTimelinePreset;
  readonly video: readonly TimelineAssetWindow[];
  readonly captions: readonly TimelineCaptionCue[];
  readonly music?: TimelineMusicTrack;
}

export class MediaTimelineValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'MediaTimelineValidationError';
  }
}

function reject(field: string, message: string): never {
  throw new MediaTimelineValidationError(field, message);
}

export function parseAssetId(value: unknown, field = 'assetId'): AssetId {
  if (typeof value !== 'string' || !/^asset_[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    return reject(field, 'expected a server-issued asset ID');
  }
  return value as AssetId;
}

function object(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return reject(field, 'expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return reject(field, 'expected an object');
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    return reject(field, 'contains an unexpected field');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return reject(`${field}.${key}`, 'required');
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    return reject(field, `expected integer milliseconds from 0 to ${max}`);
  }
  return value;
}

function range(raw: Record<string, unknown>, field: string, max: number = MEDIA_TIMELINE_LIMITS.durationMs): TimelineRange {
  const startMs = timestamp(raw.startMs, `${field}.startMs`, max);
  const endMs = timestamp(raw.endMs, `${field}.endMs`, max);
  if (endMs <= startMs) return reject(`${field}.endMs`, 'must be greater than startMs');
  return { startMs, endMs };
}

const ASSET_WINDOW_FIELDS = ['assetId', 'startMs', 'endMs', 'sourceStartMs', 'sourceEndMs'] as const;

function assetWindow(raw: Record<string, unknown>, field: string, max?: number): TimelineAssetWindow {
  const { startMs, endMs } = range(raw, field, max);
  const assetId = parseAssetId(raw.assetId, `${field}.assetId`);
  const sourceStartMs = timestamp(raw.sourceStartMs, `${field}.sourceStartMs`, MEDIA_TIMELINE_LIMITS.sourceTimestampMs);
  const sourceEndMs = timestamp(raw.sourceEndMs, `${field}.sourceEndMs`, MEDIA_TIMELINE_LIMITS.sourceTimestampMs);
  if (sourceEndMs - sourceStartMs !== endMs - startMs) {
    return reject(`${field}.sourceEndMs`, 'source and timeline durations must match');
  }
  return { assetId, startMs, endMs, sourceStartMs, sourceEndMs };
}

function list(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return reject(field, `expected an array of ${min} to ${max} entries`);
  }
  return value;
}

export function getMediaTimelineDurationMs(timeline: MediaTimelineV1): number {
  return timeline.video[timeline.video.length - 1].endMs;
}

/** Parse the bounded first-slice contract: hard cuts, one video track and one optional music track. */
export function parseMediaTimeline(input: unknown): MediaTimelineV1 {
  const raw = object(input, 'timeline', ['schemaVersion', 'preset', 'video', 'captions'], ['music']);
  if (raw.schemaVersion !== '1.0') return reject('timeline.schemaVersion', 'expected 1.0');
  if (raw.preset !== 'vertical-720p' && raw.preset !== 'vertical-1080p') {
    return reject('timeline.preset', 'expected a vertical export preset');
  }

  let durationMs = 0;
  const video = Array.from(list(raw.video, 'timeline.video', 1, MEDIA_TIMELINE_LIMITS.videoClips), (entry, i) => {
    const field = `timeline.video[${i}]`;
    const clip = assetWindow(object(entry, field, ASSET_WINDOW_FIELDS), field);
    if (clip.startMs !== durationMs) return reject(`${field}.startMs`, 'video must start at zero and use ordered, contiguous cuts');
    durationMs = clip.endMs;
    return Object.freeze(clip);
  });

  let previousCueEndMs = 0;
  const captions = Array.from(list(raw.captions, 'timeline.captions', 0, MEDIA_TIMELINE_LIMITS.captionCues), (entry, i) => {
    const field = `timeline.captions[${i}]`;
    const cue = object(entry, field, ['startMs', 'endMs', 'text']);
    const { startMs, endMs } = range(cue, field, durationMs);
    if (startMs < previousCueEndMs) return reject(`${field}.startMs`, 'caption cues must be ordered and cannot overlap');
    const { text } = cue;
    if (typeof text !== 'string' || !text.trim() || text.length > MEDIA_TIMELINE_LIMITS.captionLength || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) {
      return reject(`${field}.text`, `expected a nonempty single line up to ${MEDIA_TIMELINE_LIMITS.captionLength} characters`);
    }
    previousCueEndMs = endMs;
    return Object.freeze({ startMs, endMs, text });
  });

  const timeline = {
    schemaVersion: raw.schemaVersion,
    preset: raw.preset,
    video: Object.freeze(video),
    captions: Object.freeze(captions),
  } satisfies MediaTimelineV1;
  if (!Object.hasOwn(raw, 'music')) return Object.freeze(timeline);

  const field = 'timeline.music';
  const rawMusic = object(raw.music, field, [...ASSET_WINDOW_FIELDS, 'gain']);
  const window = assetWindow(rawMusic, field, durationMs);
  const { gain } = rawMusic;
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 1) {
    return reject(`${field}.gain`, 'expected linear gain in [0, 1]');
  }
  return Object.freeze({ ...timeline, music: Object.freeze({ ...window, gain }) });
}
