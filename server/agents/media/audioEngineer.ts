import type { TimelineAudioClip, TimelineVideoClip } from '../../media_engine/models.ts';
import type { EditPlan } from './creativeDirector.ts';
import type { MediaAnalysisReport } from './mediaAnalyst.ts';

export interface AudioMixPlan {
  audioClips: TimelineAudioClip[];
  updatedVideoClips: TimelineVideoClip[];
  loudnessTargetLufs: number;
  hasDedicatedVoiceover: boolean;
  hasBackgroundMusic: boolean;
}

/**
 * Specialist Agent 4: Audio Engineer
 * Skill binding: `ffmpeg-media-production`
 * Balances source clip speech, dedicated voiceover, and background music with fades and -16 LUFS normalization.
 */
export class AudioEngineerAgent {
  readonly skillId = 'ffmpeg-media-production';

  buildAudioMix(params: {
    editPlan: EditPlan;
    analysis: MediaAnalysisReport;
    videoClips: TimelineVideoClip[];
    durationSeconds: number;
  }): AudioMixPlan {
    const { editPlan, analysis, videoClips, durationSeconds } = params;
    const totalDuration = durationSeconds > 0 ? durationSeconds : editPlan.targetDurationSeconds;

    const voiceoverAssets = analysis.audioAssets.filter((a) =>
      /voice|vo|narration|speech|wav/i.test(`${a.asset.originalFilename} ${a.manifest.audioCodec || ''}`),
    );
    const musicAssets = analysis.audioAssets.filter((a) => !voiceoverAssets.includes(a));

    const audioClips: TimelineAudioClip[] = [];
    const hasDedicatedVoiceover = voiceoverAssets.length > 0;

    if (hasDedicatedVoiceover) {
      const vo = voiceoverAssets[0];
      const voEnd = Number(Math.min(totalDuration, vo.manifest.durationSeconds).toFixed(3));
      if (voEnd > 0.1) {
        audioClips.push({
          id: 'aud_vo_1',
          asset_id: vo.asset.id,
          role: 'voiceover',
          start: 0,
          end: voEnd,
          source_start: 0,
          source_end: voEnd,
          volume: editPlan.voiceoverVolume,
          fade_in: 0.1,
          fade_out: 0.2,
          normalize_loudness: true,
        });
      }
    }

    if (musicAssets.length > 0) {
      const music = musicAssets[0];
      const musicEnd = Number(Math.min(totalDuration, music.manifest.durationSeconds).toFixed(3));
      if (musicEnd > 0.1) {
        audioClips.push({
          id: 'aud_music_1',
          asset_id: music.asset.id,
          role: 'music',
          start: 0,
          end: musicEnd,
          source_start: 0,
          source_end: musicEnd,
          volume: hasDedicatedVoiceover ? Math.min(0.2, editPlan.musicVolume) : editPlan.musicVolume,
          fade_in: Math.min(0.8, musicEnd * 0.2),
          fade_out: Math.min(1.2, musicEnd * 0.25),
          normalize_loudness: !hasDedicatedVoiceover,
        });
      }
    }

    // Duck or mute raw camera audio when a dedicated voiceover track overrides speech.
    const updatedVideoClips = videoClips.map((vc) => ({
      ...vc,
      mute_source_audio: hasDedicatedVoiceover ? true : vc.mute_source_audio,
      volume: hasDedicatedVoiceover ? 0 : vc.volume ?? 1.0,
    }));

    return {
      audioClips,
      updatedVideoClips,
      loudnessTargetLufs: -16,
      hasDedicatedVoiceover,
      hasBackgroundMusic: musicAssets.length > 0,
    };
  }
}
