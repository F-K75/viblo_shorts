import type { MediaEngineConfig } from './config.ts';
import { MediaEngineError } from './exceptions.ts';
import {
  parseTimelineSchema,
  type ExportPreset,
  type MediaManifest,
  type TimelineAudioClip,
  type TimelineSubtitleCue,
  type TimelineSubtitleTrack,
  type TimelineSpec,
} from './models.ts';
import { parseSubtitleText } from './probe.ts';
import { getExportPreset } from './presets/index.ts';

export interface ValidatedSubtitleTrack {
  burnIn: boolean;
  fontSize: number;
  marginV: number;
  cues: TimelineSubtitleCue[];
}

export interface ValidatedTimeline {
  spec: TimelineSpec;
  preset: ExportPreset;
  derivedDurationSeconds: number;
  manifests: Record<string, MediaManifest>;
  resolvedAssetPaths: Record<string, string>;
  subtitleTracks: ValidatedSubtitleTrack[];
  warnings: string[];
}

export interface TimelineValidationContext {
  config: MediaEngineConfig;
  manifests: Record<string, MediaManifest>;
  resolvedAssetPaths: Record<string, string>;
  subtitleFileContents?: Record<string, string>;
}

/**
 * Deterministically validates a `TimelineSpec` against probed `MediaManifest` records,
 * authorized storage paths, preset limits, transition overlap rules, and derived duration.
 */
export function validateTimeline(rawTimeline: unknown, ctx: TimelineValidationContext): ValidatedTimeline {
  const spec = parseTimelineSchema(rawTimeline);
  const preset = getExportPreset(spec.format);
  const warnings: string[] = [];

  if (spec.resolution.width > ctx.config.maxWidth || spec.resolution.height > ctx.config.maxHeight) {
    throw new MediaEngineError(
      'TIMELINE_ERROR',
      `Timeline resolution ${spec.resolution.width}x${spec.resolution.height} exceeds engine limit ${ctx.config.maxWidth}x${ctx.config.maxHeight}`,
    );
  }
  if (spec.fps > ctx.config.maxFps) {
    throw new MediaEngineError('TIMELINE_ERROR', `Timeline fps (${spec.fps}) exceeds max (${ctx.config.maxFps})`);
  }
  if (!preset.allowedVideoCodecs.includes(spec.export.video_codec) && spec.export.video_codec !== 'libx264') {
    throw new MediaEngineError(
      'UNSUPPORTED_CODEC',
      `Video codec ${spec.export.video_codec} is not allowed for preset ${preset.id}`,
    );
  }
  if (spec.tracks.video.length === 0 && spec.tracks.audio.length === 0) {
    throw new MediaEngineError('TIMELINE_ERROR', 'Timeline must contain at least one video or audio clip');
  }
  if (spec.tracks.video.length > ctx.config.maxClipsPerTrack) {
    throw new MediaEngineError(
      'TIMELINE_ERROR',
      `tracks.video count (${spec.tracks.video.length}) exceeds max (${ctx.config.maxClipsPerTrack})`,
    );
  }
  if (spec.tracks.audio.length > ctx.config.maxAudioTracks) {
    throw new MediaEngineError(
      'TIMELINE_ERROR',
      `tracks.audio count (${spec.tracks.audio.length}) exceeds max (${ctx.config.maxAudioTracks})`,
    );
  }

  const requireAsset = (assetId: string, field: string): MediaManifest => {
    const manifest = ctx.manifests[assetId];
    const resolvedPath = ctx.resolvedAssetPaths[assetId];
    if (!manifest || !resolvedPath) {
      throw new MediaEngineError(
        'ASSET_ERROR',
        `${field} references unauthorized or unprobed asset: ${assetId}`,
        { httpStatus: 403, details: { assetId, field } },
      );
    }
    return manifest;
  };

  // Sort video clips deterministically by timeline start timestamp.
  const sortedVideo = [...spec.tracks.video].sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 0; i < sortedVideo.length; i++) {
    const clip = sortedVideo[i];
    const manifest = requireAsset(clip.asset_id, `tracks.video[${i}]`);
    if (!manifest.hasVideo) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.video[${i}] asset ${clip.asset_id} has no video stream`);
    }

    const timelineClipDuration = clip.end - clip.start;
    const sourceClipDuration = clip.source_end - clip.source_start;

    if (manifest.kind === 'video') {
      if (clip.source_end > manifest.durationSeconds + 0.25) {
        throw new MediaEngineError(
          'TIMELINE_ERROR',
          `tracks.video[${i}] source_end (${clip.source_end}s) exceeds source asset duration (${manifest.durationSeconds}s)`,
        );
      }
      if (Math.abs(timelineClipDuration - sourceClipDuration) > 0.15) {
        throw new MediaEngineError(
          'TIMELINE_ERROR',
          `tracks.video[${i}] output duration (${timelineClipDuration.toFixed(2)}s) does not match source window (${sourceClipDuration.toFixed(2)}s)`,
        );
      }
    }

    if (i > 0) {
      const prev = sortedVideo[i - 1];
      const overlap = prev.end - clip.start;
      if (overlap > 0.005) {
        const hasExplicitTransition =
          (prev.transition_out && prev.transition_out !== 'none') ||
          (clip.transition_in && clip.transition_in !== 'none');
        if (!hasExplicitTransition) {
          throw new MediaEngineError(
            'TIMELINE_ERROR',
            `Overlapping video clips at ${clip.start}s..${prev.end}s require explicit transition_out or transition_in semantics`,
          );
        }
        if (overlap > Math.min(prev.end - prev.start, timelineClipDuration) * 0.8) {
          throw new MediaEngineError('TIMELINE_ERROR', `Transition overlap (${overlap.toFixed(2)}s) exceeds 80% of clip duration`);
        }
      } else if (clip.start - prev.end > 0.05) {
        warnings.push(`Timeline gap of ${(clip.start - prev.end).toFixed(2)}s detected between video clips ${i - 1} and ${i}`);
      }
    }
  }

  // Derive authoritative timeline duration (never trust AI-supplied duration_seconds).
  const maxVideoEnd = sortedVideo.reduce((m, c) => Math.max(m, c.end), 0);
  const maxAudioEnd = spec.tracks.audio.reduce((m, a) => Math.max(m, a.end), 0);
  const derivedDurationSeconds = Number((sortedVideo.length > 0 ? maxVideoEnd : maxAudioEnd).toFixed(3));

  if (derivedDurationSeconds <= 0) {
    throw new MediaEngineError('TIMELINE_ERROR', 'Derived timeline duration must be greater than 0 seconds');
  }
  if (derivedDurationSeconds > ctx.config.maxDurationSeconds) {
    throw new MediaEngineError(
      'TIMELINE_ERROR',
      `Derived timeline duration (${derivedDurationSeconds}s) exceeds engine max (${ctx.config.maxDurationSeconds}s)`,
    );
  }
  if (derivedDurationSeconds > preset.maxDurationSeconds) {
    throw new MediaEngineError(
      'TIMELINE_ERROR',
      `Derived timeline duration (${derivedDurationSeconds}s) exceeds ${preset.name} limit (${preset.maxDurationSeconds}s)`,
    );
  }
  if (spec.duration_seconds > 0 && Math.abs(spec.duration_seconds - derivedDurationSeconds) > 0.25) {
    warnings.push(
      `Declared duration_seconds (${spec.duration_seconds}s) overridden by derived timeline duration (${derivedDurationSeconds}s)`,
    );
  }

  // Normalize & validate audio tracks; clamp tracks extending past video duration to avoid trailing black frames.
  const normalizedAudio: TimelineAudioClip[] = [];
  spec.tracks.audio.forEach((track, idx) => {
    const manifest = requireAsset(track.asset_id, `tracks.audio[${idx}]`);
    if (!manifest.hasAudio) {
      throw new MediaEngineError('TIMELINE_ERROR', `tracks.audio[${idx}] asset ${track.asset_id} has no audio stream`);
    }
    if (track.start >= derivedDurationSeconds) {
      warnings.push(`Audio track ${idx} starts at/after derived timeline end (${derivedDurationSeconds}s) and will be skipped`);
      return;
    }
    const clampedEnd = Math.min(track.end, derivedDurationSeconds);
    const effectiveDuration = clampedEnd - track.start;
    const sourceStart = track.source_start ?? 0;
    const requestedSourceEnd = track.source_end ?? sourceStart + effectiveDuration;
    if (sourceStart >= manifest.durationSeconds) {
      throw new MediaEngineError(
        'TIMELINE_ERROR',
        `tracks.audio[${idx}] source_start (${sourceStart}s) exceeds audio asset duration (${manifest.durationSeconds}s)`,
      );
    }
    const clampedSourceEnd = Math.min(requestedSourceEnd, manifest.durationSeconds, sourceStart + effectiveDuration);
    if (clampedEnd < track.end) {
      warnings.push(`Audio track ${idx} end (${track.end}s) clamped to derived video duration (${derivedDurationSeconds}s)`);
    }
    normalizedAudio.push({
      ...track,
      end: Number(clampedEnd.toFixed(3)),
      source_start: Number(sourceStart.toFixed(3)),
      source_end: Number(clampedSourceEnd.toFixed(3)),
    });
  });

  // Validate image overlays if present.
  if (spec.tracks.overlays) {
    spec.tracks.overlays.forEach((ov, idx) => {
      const manifest = requireAsset(ov.asset_id, `tracks.overlays[${idx}]`);
      if (!manifest.hasVideo) {
        throw new MediaEngineError('TIMELINE_ERROR', `tracks.overlays[${idx}] asset ${ov.asset_id} is not a visual asset`);
      }
    });
  }

  // Normalize subtitle tracks & inline cues.
  const subtitleTracks: ValidatedSubtitleTrack[] = [];
  const inlineCueAccumulator: TimelineSubtitleCue[] = [];

  for (let i = 0; i < spec.tracks.subtitles.length; i++) {
    const entry = spec.tracks.subtitles[i];
    if ('text' in entry && typeof entry.text === 'string' && !('cues' in entry)) {
      inlineCueAccumulator.push(entry as TimelineSubtitleCue);
      continue;
    }
    const subTrack = entry as TimelineSubtitleTrack;
    let cues: TimelineSubtitleCue[] = [];
    if (subTrack.asset_id) {
      const manifest = requireAsset(subTrack.asset_id, `tracks.subtitles[${i}]`);
      if (manifest.kind !== 'subtitle') {
        throw new MediaEngineError('TIMELINE_ERROR', `tracks.subtitles[${i}] asset ${subTrack.asset_id} is not a subtitle file`);
      }
      const rawText = ctx.subtitleFileContents?.[subTrack.asset_id];
      if (rawText) {
        cues = parseSubtitleText(rawText).cues;
      }
    } else if (subTrack.cues) {
      cues = subTrack.cues;
    }
    if (cues.length > ctx.config.maxSubtitleCues) {
      throw new MediaEngineError('TIMELINE_ERROR', `Subtitle cue count exceeds limit (${ctx.config.maxSubtitleCues})`);
    }
    const clampedCues = cues
      .filter((c) => c.start < derivedDurationSeconds)
      .map((c) => ({
        ...c,
        start: Number(Math.max(0, c.start).toFixed(3)),
        end: Number(Math.min(derivedDurationSeconds, c.end).toFixed(3)),
      }))
      .filter((c) => c.end > c.start);

    if (clampedCues.length > 0) {
      subtitleTracks.push({
        burnIn: subTrack.burn_in !== false,
        fontSize: subTrack.font_size ?? Math.round(spec.resolution.width * 0.038),
        marginV: subTrack.margin_v ?? Math.round(spec.resolution.height * 0.12),
        cues: clampedCues,
      });
    }
  }

  if (inlineCueAccumulator.length > 0) {
    if (inlineCueAccumulator.length > ctx.config.maxSubtitleCues) {
      throw new MediaEngineError('TIMELINE_ERROR', `Inline subtitle cue count exceeds limit (${ctx.config.maxSubtitleCues})`);
    }
    const clamped = inlineCueAccumulator
      .filter((c) => c.start < derivedDurationSeconds)
      .map((c) => ({
        ...c,
        start: Number(Math.max(0, c.start).toFixed(3)),
        end: Number(Math.min(derivedDurationSeconds, c.end).toFixed(3)),
      }))
      .filter((c) => c.end > c.start);
    if (clamped.length > 0) {
      subtitleTracks.push({
        burnIn: true,
        fontSize: Math.round(spec.resolution.width * 0.038),
        marginV: Math.round(spec.resolution.height * 0.12),
        cues: clamped,
      });
    }
  }

  const normalizedSpec: TimelineSpec = {
    ...spec,
    duration_seconds: derivedDurationSeconds,
    tracks: {
      ...spec.tracks,
      video: sortedVideo,
      audio: normalizedAudio,
    },
  };

  return {
    spec: normalizedSpec,
    preset,
    derivedDurationSeconds,
    manifests: ctx.manifests,
    resolvedAssetPaths: ctx.resolvedAssetPaths,
    subtitleTracks,
    warnings,
  };
}
