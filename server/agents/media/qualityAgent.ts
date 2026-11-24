import type { MediaManifest, QAReport, TimelineSpec } from '../../media_engine/models.ts';
import { getExportPreset } from '../../media_engine/presets/index.ts';
import type { ValidatedTimeline } from '../../media_engine/timeline.ts';
import type { MediaValidator } from '../../media_engine/validator.ts';

export interface RepairDecision {
  canRepair: boolean;
  repairedTimeline: TimelineSpec | null;
  appliedFixes: string[];
}

/**
 * Specialist Agent 7: Quality Agent
 * Skill binding: `ffmpeg-media-production` (STEP 6 & STEP 7: Evaluate & Repair)
 * Evaluates rendered media across 5 QA dimensions and produces a targeted timeline mutation
 * for failed checks instead of blindly repeating an identical render.
 */
export class QualityAgent {
  readonly skillId = 'ffmpeg-media-production';

  constructor(private readonly validator: MediaValidator) {}

  async evaluate(params: {
    jobId: string;
    projectId: string;
    artifactId?: string;
    outputPath: string;
    validatedTimeline: ValidatedTimeline;
    expectAudioActivity?: boolean;
    signal?: AbortSignal;
  }): Promise<{ manifest: MediaManifest; report: QAReport }> {
    return this.validator.evaluateRenderedVideo(params);
  }

  buildRepairTimeline(current: TimelineSpec, report: QAReport): RepairDecision {
    if (!report.revision_required || report.repair_actions.length === 0) {
      return { canRepair: false, repairedTimeline: null, appliedFixes: [] };
    }

    const cloned: TimelineSpec = JSON.parse(JSON.stringify(current));
    const appliedFixes: string[] = [];

    if (
      report.repair_actions.includes('close_timeline_gaps_or_trim_black_leader') ||
      report.repair_actions.includes('snap_sequential_clips')
    ) {
      let cursor = 0;
      cloned.tracks.video = cloned.tracks.video.map((clip) => {
        const dur = Number((clip.source_end - clip.source_start).toFixed(3));
        const next = {
          ...clip,
          start: Number(cursor.toFixed(3)),
          end: Number((cursor + dur).toFixed(3)),
        };
        cursor += dur;
        return next;
      });
      cloned.duration_seconds = Number(cursor.toFixed(3));
      appliedFixes.push('Snapped sequential video clips to eliminate black-frame timeline gaps');
    }

    if (report.repair_actions.includes('enable_loudnorm_and_reduce_gain')) {
      cloned.tracks.audio = cloned.tracks.audio.map((aud) => ({
        ...aud,
        volume: Number(Math.max(0.05, aud.volume * 0.65).toFixed(3)),
        normalize_loudness: true,
      }));
      cloned.tracks.video = cloned.tracks.video.map((vc) => ({
        ...vc,
        volume: Number(Math.min(0.85, (vc.volume ?? 1) * 0.75).toFixed(3)),
      }));
      appliedFixes.push('Reduced audio gain and enabled -16 LUFS loudnorm to eliminate peak clipping');
    }

    if (report.repair_actions.includes('restore_audio_mix_gain')) {
      cloned.tracks.video = cloned.tracks.video.map((vc) => ({
        ...vc,
        mute_source_audio: false,
        volume: Math.max(0.8, vc.volume ?? 1),
      }));
      cloned.tracks.audio = cloned.tracks.audio.map((aud) => ({
        ...aud,
        volume: Math.max(0.25, aud.volume),
      }));
      appliedFixes.push('Restored muted/zero-gain audio tracks');
    }

    if (
      report.repair_actions.includes('enforce_resolution_scale_crop') ||
      report.repair_actions.includes('enforce_vertical_preset')
    ) {
      const preset = getExportPreset(cloned.format);
      cloned.resolution = { width: preset.width, height: preset.height };
      cloned.fps = preset.fps;
      cloned.tracks.video = cloned.tracks.video.map((vc) => ({ ...vc, fit_mode: 'cover' }));
      appliedFixes.push(`Enforced ${preset.width}x${preset.height} preset bounds and cover scaling`);
    }

    if (report.repair_actions.includes('trim_static_footage_or_increase_cut_cadence')) {
      let cursor = 0;
      cloned.tracks.video = cloned.tracks.video.map((vc) => {
        const curDur = vc.source_end - vc.source_start;
        const trimmedDur = Number(Math.max(1.0, Math.min(curDur, 3.5)).toFixed(3));
        const next = {
          ...vc,
          source_end: Number((vc.source_start + trimmedDur).toFixed(3)),
          start: Number(cursor.toFixed(3)),
          end: Number((cursor + trimmedDur).toFixed(3)),
        };
        cursor += trimmedDur;
        return next;
      });
      cloned.duration_seconds = Number(cursor.toFixed(3));
      appliedFixes.push('Trimmed static clip tails to improve visual pacing');
    }

    return {
      canRepair: appliedFixes.length > 0,
      repairedTimeline: appliedFixes.length > 0 ? cloned : null,
      appliedFixes,
    };
  }
}
