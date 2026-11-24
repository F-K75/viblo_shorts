import { MediaEngineError } from '../exceptions.ts';
import type { ExportPreset, PresetId } from '../models.ts';
import { INSTAGRAM_REEL_PRESET } from './instagramReel.ts';
import { LANDSCAPE_AD_PRESET, SQUARE_SOCIAL_PRESET } from './promotional.ts';
import { YOUTUBE_SHORT_PRESET } from './youtubeShort.ts';
import { YOUTUBE_1080P_PRESET, YOUTUBE_4K_PRESET } from './youtubeVideo.ts';

export const EXPORT_PRESETS: Readonly<Record<PresetId, ExportPreset>> = {
  instagram_reel: INSTAGRAM_REEL_PRESET,
  youtube_short: YOUTUBE_SHORT_PRESET,
  youtube_1080p: YOUTUBE_1080P_PRESET,
  youtube_4k: YOUTUBE_4K_PRESET,
  square_social: SQUARE_SOCIAL_PRESET,
  landscape_ad: LANDSCAPE_AD_PRESET,
};

export function getExportPreset(id: unknown): ExportPreset {
  if (typeof id !== 'string' || !(id in EXPORT_PRESETS)) {
    throw new MediaEngineError('TIMELINE_ERROR', `Unknown export preset: ${String(id)}`, {
      details: { preset: id, available: Object.keys(EXPORT_PRESETS) },
    });
  }
  return EXPORT_PRESETS[id as PresetId];
}

export function listExportPresets(): ExportPreset[] {
  return Object.values(EXPORT_PRESETS);
}
