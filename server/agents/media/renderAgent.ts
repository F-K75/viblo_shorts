import fs from 'fs';
import path from 'path';
import type { FfmpegCommandBuilder } from '../../media_engine/commandBuilder.ts';
import type { FfmpegExecutor } from '../../media_engine/executor.ts';
import { serializeCuesToSrt } from '../../media_engine/filterGraph.ts';
import type { QualityProfile } from '../../media_engine/models.ts';
import type { MediaStorage } from '../../media_engine/storage.ts';
import type { ValidatedTimeline } from '../../media_engine/timeline.ts';

export interface RenderExecutionOutput {
  stagedVideoPath: string;
  stagingDir: string;
  sizeBytes: number;
  elapsedMs: number;
}

/**
 * Specialist Agent 6: Render Agent
 * Skill binding: `ffmpeg-media-production`
 * Stages sanitized SRT files inside an isolated per-job directory, builds allowlisted argument arrays,
 * and invokes `FfmpegExecutor`. Caller cleans up `stagingDir` after QA + artifact publication.
 */
export class RenderAgent {
  readonly skillId = 'ffmpeg-media-production';

  constructor(
    private readonly commandBuilder: FfmpegCommandBuilder,
    private readonly executor: FfmpegExecutor,
    private readonly storage: MediaStorage,
  ) {}

  async executeTimelineRender(params: {
    jobId: string;
    validatedTimeline: ValidatedTimeline;
    qualityProfile: QualityProfile;
    onProgress?: (pct: number, sec: number) => void;
    signal?: AbortSignal;
  }): Promise<RenderExecutionOutput> {
    const stagingDir = this.storage.createJobStagingDir(params.jobId);
    try {
      let stagedSubtitlePath: string | null = null;
      const burnTrack = params.validatedTimeline.subtitleTracks.find((t) => t.burnIn && t.cues.length > 0);
      if (burnTrack) {
        stagedSubtitlePath = path.join(stagingDir, 'captions.srt');
        const srtBody = serializeCuesToSrt(burnTrack.cues);
        fs.writeFileSync(stagedSubtitlePath, srtBody, { encoding: 'utf8', mode: 0o600 });
      }

      const ext = params.validatedTimeline.spec.export.container;
      const stagedOutputPath = path.join(stagingDir, `render_output.${ext}`);

      const command = this.commandBuilder.buildTimelineRender(params.validatedTimeline, stagedOutputPath, {
        qualityProfile: params.qualityProfile,
        stagedSubtitlePath,
      });

      const result = await this.executor.execute(command, {
        jobId: params.jobId,
        expectedDurationSeconds: params.validatedTimeline.derivedDurationSeconds,
        onProgress: params.onProgress,
        signal: params.signal,
      });

      return {
        stagedVideoPath: result.outputPath,
        stagingDir,
        sizeBytes: result.sizeBytes,
        elapsedMs: result.elapsedMs,
      };
    } catch (err) {
      this.storage.cleanupStagingDir(stagingDir);
      throw err;
    }
  }
}
