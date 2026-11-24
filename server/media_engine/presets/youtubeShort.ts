import type { ExportPreset } from '../models.ts';

export const YOUTUBE_SHORT_PRESET: ExportPreset = {
  id: 'youtube_short',
  name: 'YouTube Short',
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
  crfByQuality: { draft: 26, standard: 21, high: 18 },
  ffmpegPresetByQuality: { draft: 'ultrafast', standard: 'fast', high: 'medium' },
  maxDurationSeconds: 180,
  maxFileSizeBytes: 300 * 1024 * 1024,
};
