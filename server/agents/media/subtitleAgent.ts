import type { TimelineSubtitleCue, TimelineSubtitleTrack } from '../../media_engine/models.ts';
import { getExportPreset } from '../../media_engine/presets/index.ts';
import type { EditPlan } from './creativeDirector.ts';
import type { MediaAnalysisReport } from './mediaAnalyst.ts';

/**
 * Specialist Agent 5: Subtitle Agent
 * Skill binding: `ffmpeg-media-production`
 * Builds safe-zone-positioned subtitle tracks from uploaded SRT/WebVTT assets or Creative Director caption cues.
 */
export class SubtitleAgent {
  readonly skillId = 'ffmpeg-media-production';

  buildSubtitleTracks(params: {
    editPlan: EditPlan;
    analysis: MediaAnalysisReport;
    durationSeconds: number;
  }): TimelineSubtitleTrack[] {
    const { editPlan, analysis, durationSeconds } = params;
    const preset = getExportPreset(editPlan.format);
    const marginV = Math.round(preset.height * 0.14);
    const fontSize = Math.round(preset.width * 0.038);

    if (analysis.subtitleAssets.length > 0) {
      return analysis.subtitleAssets.map((sub, idx) => ({
        id: `sub_asset_${idx + 1}`,
        asset_id: sub.asset.id,
        format: sub.manifest.formatName === 'vtt' ? 'vtt' : 'srt',
        burn_in: true,
        font_size: fontSize,
        margin_v: marginV,
      }));
    }

    if (!editPlan.burnSubtitles || editPlan.captionLines.length === 0 || durationSeconds < 0.8) {
      return [];
    }

    const lines = editPlan.captionLines;
    const slot = durationSeconds / lines.length;
    const cues: TimelineSubtitleCue[] = [];
    for (let i = 0; i < lines.length; i++) {
      const start = Number((i * slot + 0.1).toFixed(3));
      const end = Number(Math.min(durationSeconds - 0.05, (i + 1) * slot - 0.05).toFixed(3));
      if (end - start >= 0.25 && lines[i]) {
        cues.push({
          id: `cue_${i + 1}`,
          start,
          end,
          text: lines[i],
        });
      }
    }

    if (cues.length === 0) return [];
    return [
      {
        id: 'sub_inline_1',
        format: 'inline',
        burn_in: true,
        font_size: fontSize,
        margin_v: marginV,
        cues,
      },
    ];
  }
}
