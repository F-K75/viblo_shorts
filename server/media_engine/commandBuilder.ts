import path from 'path';
import type { MediaEngineConfig } from './config.ts';
import { MediaEngineError } from './exceptions.ts';
import { buildTimelineFilterGraph, escapeFfmpegFilterPath } from './filterGraph.ts';
import type { QualityProfile } from './models.ts';
import type { ValidatedTimeline } from './timeline.ts';

export interface BuiltFfmpegCommand {
  binary: string;
  args: string[];
  outputPath: string;
}

function assertSafeLocalPath(p: string, label: string): string {
  if (!p || typeof p !== 'string' || /[\u0000-\u001F\u007F]/.test(p)) {
    throw new MediaEngineError('ASSET_ERROR', `Invalid ${label} path`);
  }
  if (!path.isAbsolute(p)) {
    throw new MediaEngineError('ASSET_ERROR', `${label} must be an absolute resolved path`);
  }
  return p;
}

/**
 * Builds argument-array-only FFmpeg invocations (`shell: false`).
 * Enforces per-input `-protocol_whitelist` + `-threads` BEFORE every `-i`, and output `-threads` before every output path.
 */
export class FfmpegCommandBuilder {
  constructor(private readonly config: MediaEngineConfig) {}

  private globalFlags(): string[] {
    return ['-nostdin', '-y'];
  }

  private perInputGuards(): string[] {
    return [
      '-threads',
      String(this.config.maxThreads),
      '-protocol_whitelist',
      this.config.protocolWhitelist,
    ];
  }

  private outputThreadCap(): string[] {
    return ['-threads', String(this.config.maxThreads)];
  }

  /** Full multi-track timeline render command. */
  buildTimelineRender(
    validated: ValidatedTimeline,
    outputPath: string,
    opts: { qualityProfile?: QualityProfile; stagedSubtitlePath?: string | null } = {},
  ): BuiltFfmpegCommand {
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    const quality = opts.qualityProfile ?? 'standard';
    const graph = buildTimelineFilterGraph(validated, this.config, opts.stagedSubtitlePath);
    const { spec, preset, derivedDurationSeconds } = validated;

    const args: string[] = [...this.globalFlags()];
    // Security rule (P0-1): `-protocol_whitelist` and `-threads` are per-input options in FFmpeg and MUST precede EVERY `-i`.
    for (const inputPath of graph.inputFiles) {
      assertSafeLocalPath(inputPath, 'inputFile');
      args.push(...this.perInputGuards(), '-i', inputPath);
    }

    args.push('-filter_complex', graph.filterComplex);

    if (graph.videoOutputLabel) {
      args.push('-map', graph.videoOutputLabel);
      const vCodec = spec.export.video_codec === 'copy' ? 'libx264' : spec.export.video_codec;
      const encPreset = spec.export.preset ?? preset.ffmpegPresetByQuality[quality];
      const crf = spec.export.crf ?? preset.crfByQuality[quality];
      args.push(
        '-c:v',
        vCodec,
        '-preset',
        encPreset,
        '-crf',
        String(crf),
        '-maxrate',
        spec.export.video_bitrate,
        '-bufsize',
        spec.export.video_bitrate,
        '-pix_fmt',
        spec.export.pixel_format,
        '-r',
        String(spec.fps),
      );
    } else {
      args.push('-vn');
    }

    if (graph.audioOutputLabel) {
      args.push('-map', graph.audioOutputLabel);
      const aCodec = spec.export.audio_codec === 'copy' ? 'aac' : spec.export.audio_codec;
      args.push('-c:a', aCodec);
      if (aCodec === 'aac') {
        args.push('-b:a', spec.export.audio_bitrate ?? preset.audioBitrate);
      } else if (aCodec === 'libmp3lame') {
        args.push('-q:a', '2');
      }
    } else {
      args.push('-an');
    }

    if (spec.export.container === 'mp4' || spec.export.container === 'mov') {
      args.push('-movflags', '+faststart');
    }

    args.push(...this.outputThreadCap(), '-t', derivedDurationSeconds.toFixed(3), safeOut);
    return { binary: this.config.ffmpegBin, args, outputPath: safeOut };
  }

  /** Section 6.B: Convert landscape/arbitrary video to vertical 1080x1920 H.264 + AAC. */
  buildConvertVertical(inputPath: string, outputPath: string, width = 1080, height = 1920): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    if (width < 128 || height < 128 || width % 2 !== 0 || height % 2 !== 0) {
      throw new MediaEngineError('FILTER_ERROR', `Invalid vertical target dimensions ${width}x${height}`);
    }
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-i', safeIn,
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }

  /** Section 6.C: Exact timestamp video trim. */
  buildTrimVideo(inputPath: string, outputPath: string, startSeconds: number, durationSeconds: number): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new MediaEngineError('TIMELINE_ERROR', 'Invalid trim startSeconds or durationSeconds');
    }
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-ss', startSeconds.toFixed(3),
        '-i', safeIn,
        '-t', durationSeconds.toFixed(3),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }

  /** Section 6.D: Extract MP3 audio stream. */
  buildExtractAudio(inputPath: string, outputPath: string): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-i', safeIn,
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '2',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }

  /** Section 6.E: Burn validated SRT subtitles into video. */
  buildBurnSubtitles(inputPath: string, srtPath: string, outputPath: string): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeSrt = assertSafeLocalPath(srtPath, 'srtPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    const escapedSrt = escapeFfmpegFilterPath(safeSrt);
    const fontDirOpt = this.config.bundledFontPath
      ? `:fontsdir='${escapeFfmpegFilterPath(path.dirname(this.config.bundledFontPath))}'`
      : '';
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-i', safeIn,
        '-vf', `subtitles=filename='${escapedSrt}'${fontDirOpt}`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }

  /** Section 6.F: Normalize integrated loudness (-16 LUFS). */
  buildNormalizeAudio(inputPath: string, outputPath: string, targetI = -16, truePeak = -1.5, lra = 11): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    if (!Number.isFinite(targetI) || targetI < -30 || targetI > -5) {
      throw new MediaEngineError('FILTER_ERROR', `Invalid loudnorm target I=${targetI}`);
    }
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-i', safeIn,
        '-af', `loudnorm=I=${targetI}:TP=${truePeak}:LRA=${lra}`,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }

  /** Section 6.G: Extract single JPEG thumbnail frame. */
  buildThumbnail(inputPath: string, outputPath: string, timestampSeconds = 1): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
      throw new MediaEngineError('TIMELINE_ERROR', 'Thumbnail timestampSeconds must be >= 0');
    }
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-ss', timestampSeconds.toFixed(3),
        '-i', safeIn,
        '-frames:v', '1',
        '-q:v', '2',
        '-update', '1',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }

  /** Section 6.H: Apply fade-in and fade-out transitions. */
  buildFadeVideo(
    inputPath: string,
    outputPath: string,
    fadeInDuration: number,
    fadeOutStart: number,
    fadeOutDuration: number,
  ): BuiltFfmpegCommand {
    const safeIn = assertSafeLocalPath(inputPath, 'inputPath');
    const safeOut = assertSafeLocalPath(outputPath, 'outputPath');
    if (fadeInDuration < 0 || fadeOutStart < 0 || fadeOutDuration < 0) {
      throw new MediaEngineError('FILTER_ERROR', 'Fade durations and timestamps must be non-negative');
    }
    return {
      binary: this.config.ffmpegBin,
      outputPath: safeOut,
      args: [
        ...this.globalFlags(),
        ...this.perInputGuards(),
        '-i', safeIn,
        '-vf', `fade=t=in:st=0:d=${fadeInDuration.toFixed(3)},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDuration.toFixed(3)}`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        ...this.outputThreadCap(),
        safeOut,
      ],
    };
  }
}
