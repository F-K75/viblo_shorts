import type { TimelineImageOverlay, TimelineVideoClip } from '../../media_engine/models.ts';
import { getExportPreset } from '../../media_engine/presets/index.ts';
import type { EditPlan } from './creativeDirector.ts';
import type { MediaAnalysisReport } from './mediaAnalyst.ts';

/**
 * Specialist Agent 3: Video Editor
 * Skill binding: `ffmpeg-media-production`
 * Converts the `EditPlan` into frame-aligned, gap-free `TimelineVideoClip[]` and optional brand overlays.
 */
export class VideoEditorAgent {
  readonly skillId = 'ffmpeg-media-production';

  arrangeVideoTrack(params: {
    editPlan: EditPlan;
    analysis: MediaAnalysisReport;
  }): { videoClips: TimelineVideoClip[]; overlays: TimelineImageOverlay[]; durationSeconds: number } {
    const preset = getExportPreset(params.editPlan.format);
    const videoClips: TimelineVideoClip[] = [];
    let cursor = 0;

    for (let i = 0; i < params.editPlan.segments.length; i++) {
      const seg = params.editPlan.segments[i];
      const dur = Number((seg.sourceEnd - seg.sourceStart).toFixed(3));
      if (dur <= 0) continue;
      const start = Number(cursor.toFixed(3));
      const end = Number((cursor + dur).toFixed(3));

      videoClips.push({
        id: `vclip_${i + 1}`,
        asset_id: seg.assetId,
        start,
        end,
        source_start: seg.sourceStart,
        source_end: seg.sourceEnd,
        ...(i > 0 ? { transition_in: 'fade', transition_duration: 0.35 } : {}),
        ...(seg.transitionOut !== 'none' ? { transition_out: seg.transitionOut, transition_duration: 0.35 } : {}),
        fit_mode: 'cover',
        mute_source_audio: false,
        volume: 1.0,
      });
      cursor = end;
    }

    // Fallback if only an image asset was provided without video clips
    if (videoClips.length === 0 && params.analysis.imageAssets.length > 0) {
      const img = params.analysis.imageAssets[0];
      const dur = Math.min(preset.maxDurationSeconds, Math.max(3, params.editPlan.targetDurationSeconds));
      videoClips.push({
        id: 'vclip_img_1',
        asset_id: img.asset.id,
        start: 0,
        end: dur,
        source_start: 0,
        source_end: dur,
        transition_in: 'fade',
        transition_out: 'fade',
        transition_duration: 0.4,
        fit_mode: 'cover',
      });
      cursor = dur;
    }

    const overlays: TimelineImageOverlay[] = [];
    if (videoClips.length > 0 && params.analysis.imageAssets.length > 0 && params.analysis.videoAssets.length > 0) {
      const logo = params.analysis.imageAssets[0];
      const logoSize = Math.round(preset.width * 0.14);
      overlays.push({
        id: 'overlay_logo_1',
        asset_id: logo.asset.id,
        start: 0,
        end: cursor,
        x: preset.width - logoSize - 36,
        y: 36,
        width: logoSize,
        height: logoSize,
        opacity: 0.9,
      });
    }

    return {
      videoClips,
      overlays,
      durationSeconds: Number(cursor.toFixed(3)),
    };
  }
}
