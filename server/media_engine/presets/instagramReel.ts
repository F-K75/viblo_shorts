import type { ExportPreset } from '../models.ts';

export const INSTAGRAM_REEL_PRESET: ExportPreset = {
  id: 'instagram_reel',
  name: 'Instagram Reel',
  aspectRatio: '9:16',
  width: 1080,
  height: 1920,
  fps: 30,
  container: 'mp4',
  videoCodec: 'libx264',
  allowedVideoCodecs: ['libx264'],
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  videoBitrate: '8M',
  audioBitrate: '192k',
  crfByQuality: { draft: 26, standard: 22, high: 19 },
  ffmpegPresetByQuality: { draft: 'ultrafast', standard: 'fast', high: 'medium' },
  maxDurationSeconds: 90,
  maxFileSizeBytes: 250 * 1024 * 1024,
};
