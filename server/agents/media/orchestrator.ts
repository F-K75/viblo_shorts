import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FfmpegCommandBuilder } from '../../media_engine/commandBuilder.ts';
import type { MediaEngineConfig } from '../../media_engine/config.ts';
import { classifyMediaError, MediaEngineError } from '../../media_engine/exceptions.ts';
import { FfmpegExecutor } from '../../media_engine/executor.ts';
import type { MediaMetadataStore } from '../../media_engine/mediaStore.ts';
import type {
  MediaArtifactRecord,
  MediaAssetRecord,
  MediaJobStage,
  MediaProjectRecord,
  PresetId,
  QAReport,
  QualityProfile,
  RenderOutputContract,
  TimelineSpec,
} from '../../media_engine/models.ts';
import { getExportPreset } from '../../media_engine/presets/index.ts';
import { MediaProbe } from '../../media_engine/probe.ts';
import { MediaEventBus } from '../../media_engine/progress.ts';
import { MediaStorage } from '../../media_engine/storage.ts';
import { validateTimeline, type ValidatedTimeline } from '../../media_engine/timeline.ts';
import { MediaValidator } from '../../media_engine/validator.ts';
import { AudioEngineerAgent } from './audioEngineer.ts';
import { CreativeDirectorAgent, type StructuredLlmGenerator } from './creativeDirector.ts';
import { MediaAnalystAgent } from './mediaAnalyst.ts';
import { QualityAgent } from './qualityAgent.ts';
import { RenderAgent } from './renderAgent.ts';
import { SubtitleAgent } from './subtitleAgent.ts';
import { VideoEditorAgent } from './videoEditor.ts';

export const SKILL_ACTIVATION_MATRIX = {
  skillId: 'ffmpeg-media-production',
  skillPath: 'skills/ffmpeg/SKILL.md',
  executionEnabledAgents: [
    'media_analyst',
    'video_editor',
    'audio_engineer',
    'subtitle_agent',
    'render_agent',
    'quality_agent',
  ],
  capabilityOnlyAgents: ['creative_director'],
} as const;

export interface QueuedMediaRenderPayload {
  projectId: string;
  tenantId: string;
  timelineVersion: number;
  preset: PresetId;
  qualityProfile: QualityProfile;
  timeline: TimelineSpec;
  correlationId: string;
  expectAudioActivity?: boolean;
}

/**
 * Deterministic Media Production Orchestrator (Sections 1, 3, 4, 9, 10).
 * Coordinates the 7 specialist agents across inspection, planning, timeline validation,
 * queued FFmpeg execution, 5-dimension QA scoring, and single-pass automated repair.
 */
export class MediaProductionOrchestrator {
  readonly storage: MediaStorage;
  readonly probe: MediaProbe;
  readonly commandBuilder: FfmpegCommandBuilder;
  readonly executor: FfmpegExecutor;
  readonly validator: MediaValidator;
  readonly events: MediaEventBus;

  readonly mediaAnalyst: MediaAnalystAgent;
  readonly creativeDirector: CreativeDirectorAgent;
  readonly videoEditor: VideoEditorAgent;
  readonly audioEngineer: AudioEngineerAgent;
  readonly subtitleAgent: SubtitleAgent;
  readonly renderAgent: RenderAgent;
  readonly qualityAgent: QualityAgent;

  constructor(
    readonly config: MediaEngineConfig,
    readonly metadataStore: MediaMetadataStore,
    llmGenerate?: StructuredLlmGenerator,
  ) {
    this.storage = new MediaStorage(config);
    this.probe = new MediaProbe(config, this.storage);
    this.commandBuilder = new FfmpegCommandBuilder(config);
    this.executor = new FfmpegExecutor(config);
    this.validator = new MediaValidator(config, this.probe);
    this.events = new MediaEventBus(config);

    this.mediaAnalyst = new MediaAnalystAgent(this.probe, this.storage, this.metadataStore);
    this.creativeDirector = new CreativeDirectorAgent(llmGenerate);
    this.videoEditor = new VideoEditorAgent();
    this.audioEngineer = new AudioEngineerAgent();
    this.subtitleAgent = new SubtitleAgent();
    this.renderAgent = new RenderAgent(this.commandBuilder, this.executor, this.storage);
    this.qualityAgent = new QualityAgent(this.validator);
  }

  newProjectId(): string {
    return `mproj_${crypto.randomBytes(12).toString('hex')}`;
  }

  async registerAndInspectAsset(params: {
    tenantId: string;
    originalFilename: string;
    data: Buffer;
    kind?: MediaAssetRecord['kind'];
    autoProbe?: boolean;
  }): Promise<MediaAssetRecord> {
    const { record, localPath } = await this.storage.registerAssetFromBuffer(params);
    await this.metadataStore.saveAsset(record);
    this.events.publish({
      eventType: 'media.asset.uploaded',
      tenantId: params.tenantId,
      projectId: 'workspace',
      payload: { assetId: record.id, kind: record.kind, sizeBytes: record.sizeBytes },
    });

    if (params.autoProbe !== false) {
      const manifest = await this.probe.inspectFile(localPath, record.id, record.kind);
      record.manifest = manifest;
      await this.metadataStore.saveAsset(record);
      this.events.publish({
        eventType: 'media.asset.probed',
        tenantId: params.tenantId,
        projectId: 'workspace',
        payload: {
          assetId: record.id,
          durationSeconds: manifest.durationSeconds,
          width: manifest.width,
          height: manifest.height,
        },
      });
    }
    return record;
  }

  async inspectAssetById(assetId: string, tenantId: string): Promise<MediaAssetRecord> {
    // Uniform 404 lookup scoped by tenantId prevents cross-tenant asset ID enumeration oracles.
    const asset = await this.metadataStore.getAsset(assetId, tenantId);
    if (!asset) {
      throw new MediaEngineError('ASSET_ERROR', 'Media asset not found', { httpStatus: 404 });
    }
    const manifest = await this.probe.inspect(asset, tenantId);
    asset.manifest = manifest;
    await this.metadataStore.saveAsset(asset);
    this.events.publish({
      eventType: 'media.asset.probed',
      tenantId,
      projectId: 'workspace',
      payload: { assetId: asset.id, durationSeconds: manifest.durationSeconds },
    });
    return asset;
  }

  /**
   * Runs the AI + deterministic multi-agent planning pipeline:
   * Media Analyst -> Creative Director -> Video Editor -> Audio Engineer -> Subtitle Agent -> Timeline Validator.
   */
  async planProjectTimeline(params: {
    project: MediaProjectRecord;
    tenantId: string;
  }): Promise<{ project: MediaProjectRecord; validated: ValidatedTimeline }> {
    const { project, tenantId } = params;
    const uniqueIds = Array.from(new Set(project.assetIds)).slice(0, this.config.maxClipsPerTrack + this.config.maxAudioTracks);
    const assets: MediaAssetRecord[] = [];
    for (const id of uniqueIds) {
      const a = await this.metadataStore.getAsset(id, tenantId);
      if (!a) {
        throw new MediaEngineError('ASSET_ERROR', `Asset not found: ${id}`, { httpStatus: 404 });
      }
      assets.push(a);
    }

    const analysis = await this.mediaAnalyst.analyzeAssets({
      projectId: project.id,
      tenantId,
      assets,
    });

    const editPlan = await this.creativeDirector.createEditPlan({
      brief: project.brief,
      format: project.format,
      analysis,
    });

    const arranged = this.videoEditor.arrangeVideoTrack({ editPlan, analysis });
    const audioMix = this.audioEngineer.buildAudioMix({
      editPlan,
      analysis,
      videoClips: arranged.videoClips,
      durationSeconds: arranged.durationSeconds,
    });
    const subtitles = this.subtitleAgent.buildSubtitleTracks({
      editPlan,
      analysis,
      durationSeconds: arranged.durationSeconds,
    });

    const preset = getExportPreset(project.format);
    const candidateTimeline: TimelineSpec = {
      schema_version: '1.0',
      project_id: project.id,
      format: project.format,
      resolution: { width: preset.width, height: preset.height },
      fps: preset.fps,
      duration_seconds: arranged.durationSeconds,
      tracks: {
        video: audioMix.updatedVideoClips,
        audio: audioMix.audioClips,
        subtitles,
        ...(arranged.overlays.length > 0 ? { overlays: arranged.overlays } : {}),
      },
      export: {
        container: preset.container,
        video_codec: preset.videoCodec,
        audio_codec: preset.audioCodec,
        pixel_format: preset.pixelFormat,
        video_bitrate: preset.videoBitrate,
        audio_bitrate: preset.audioBitrate,
      },
    };

    const validated = validateTimeline(candidateTimeline, {
      config: this.config,
      manifests: analysis.manifestsById,
      resolvedAssetPaths: analysis.resolvedPathsById,
      subtitleFileContents: analysis.subtitleContentsById,
    });

    const updated: MediaProjectRecord = {
      ...project,
      timeline: validated.spec,
      timelineVersion: project.timelineVersion + 1,
      editPlan: editPlan as unknown as Record<string, unknown>,
      audioMixPlan: {
        loudnessTargetLufs: audioMix.loudnessTargetLufs,
        hasDedicatedVoiceover: audioMix.hasDedicatedVoiceover,
        hasBackgroundMusic: audioMix.hasBackgroundMusic,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.metadataStore.saveProject(updated);
    this.events.publish({
      eventType: 'media.timeline.updated',
      tenantId,
      projectId: updated.id,
      payload: { timelineVersion: updated.timelineVersion, durationSeconds: validated.derivedDurationSeconds },
    });

    return { project: updated, validated };
  }

  async validateProjectTimeline(timeline: unknown, tenantId: string): Promise<ValidatedTimeline> {
    const rawObj = (timeline && typeof timeline === 'object' ? timeline : {}) as Record<string, unknown>;
    const tracks = (rawObj.tracks && typeof rawObj.tracks === 'object' ? rawObj.tracks : {}) as Record<string, unknown>;
    const collectIds = new Set<string>();
    for (const arr of [tracks.video, tracks.audio, tracks.subtitles, tracks.overlays]) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).asset_id === 'string') {
          collectIds.add((item as Record<string, unknown>).asset_id as string);
        }
      }
    }

    const assets: MediaAssetRecord[] = [];
    for (const id of collectIds) {
      const a = await this.metadataStore.getAsset(id, tenantId);
      if (!a) {
        throw new MediaEngineError('ASSET_ERROR', `Referenced asset not found: ${id}`, { httpStatus: 404 });
      }
      assets.push(a);
    }

    const analysis = await this.mediaAnalyst.analyzeAssets({
      projectId: String(rawObj.project_id || 'project'),
      tenantId,
      assets,
    });

    return validateTimeline(timeline, {
      config: this.config,
      manifests: analysis.manifestsById,
      resolvedAssetPaths: analysis.resolvedPathsById,
      subtitleFileContents: analysis.subtitleContentsById,
    });
  }

  /**
   * Invoked exclusively by `executeRenderJob` in the central queue worker (`server.ts`) so that
   * every render honors admission control, fairness, cancellation, and atomic render-minute billing.
   */
  async executeQueuedRenderJob(params: {
    jobId: string;
    payload: QueuedMediaRenderPayload;
    onProgress?: (progress: number, stage: MediaJobStage, message: string) => void;
    signal?: AbortSignal;
  }): Promise<{
    artifact: MediaArtifactRecord;
    qaReport: QAReport;
    outputContract: RenderOutputContract;
    repaired: boolean;
    appliedFixes: string[];
  }> {
    const { jobId, payload, onProgress, signal } = params;
    const { tenantId, projectId, qualityProfile, correlationId } = payload;

    const notify = (progress: number, stage: MediaJobStage, message: string, eventType?: Parameters<MediaEventBus['publish']>[0]['eventType']) => {
      onProgress?.(progress, stage, message);
      if (eventType) {
        this.events.publish({
          eventType,
          tenantId,
          projectId,
          jobId,
          correlationId,
          progress,
          stage,
          payload: { message },
        });
      }
    };

    notify(8, 'validating_timeline', 'Validating timeline and media assets...', 'media.render.started');

    let currentValidated = await this.validateProjectTimeline(payload.timeline, tenantId);
    let repaired = false;
    let appliedFixes: string[] = [];
    let finalArtifact: MediaArtifactRecord | null = null;
    let finalQaReport: QAReport | null = null;

    // Controlled execution + single automated QA repair pass if score < 80 and fixable.
    for (let pass = 1; pass <= 2; pass++) {
      const renderOut = await this.renderAgent.executeTimelineRender({
        jobId,
        validatedTimeline: currentValidated,
        qualityProfile,
        signal,
        onProgress: (pct) => {
          const scaledPct = pass === 1 ? 15 + Math.round(pct * 0.55) : 78 + Math.round(pct * 0.12);
          notify(scaledPct, 'encoding', `Encoding media (${pct}%)...`, 'media.render.progress');
        },
      });

      try {
        notify(pass === 1 ? 74 : 92, 'evaluating_qa', 'Running FFmpeg quality evaluation...', 'media.qa.started');
        const evalOut = await this.qualityAgent.evaluate({
          jobId,
          projectId,
          outputPath: renderOut.stagedVideoPath,
          validatedTimeline: currentValidated,
          expectAudioActivity: payload.expectAudioActivity,
          signal,
        });

        this.events.publish({
          eventType: 'media.qa.completed',
          tenantId,
          projectId,
          jobId,
          correlationId,
          progress: pass === 1 ? 82 : 95,
          stage: 'evaluating_qa',
          payload: { score: evalOut.report.total_score, band: evalOut.report.band, pass },
        });

        // Attempt 1 controlled repair loop when QA fails (< 80) and QualityAgent produces a concrete timeline fix.
        if (pass === 1 && evalOut.report.revision_required) {
          const decision = this.qualityAgent.buildRepairTimeline(currentValidated.spec, evalOut.report);
          if (decision.canRepair && decision.repairedTimeline) {
            this.storage.cleanupStagingDir(renderOut.stagingDir);
            notify(76, 'repairing', `Applying automated QA repair: ${decision.appliedFixes.join('; ')}`, 'media.render.progress');
            currentValidated = await this.validateProjectTimeline(decision.repairedTimeline, tenantId);
            repaired = true;
            appliedFixes = decision.appliedFixes;
            continue;
          }
        }

        if (evalOut.report.total_score < 65) {
          await this.metadataStore.saveQAReport(tenantId, evalOut.report);
          throw new MediaEngineError(
            'QUALITY_FAILURE',
            `Rendered output rejected by QA scorecard (${evalOut.report.total_score}/100): ${evalOut.report.failures.join('; ') || 'below threshold'}`,
            { details: { qaScore: evalOut.report.total_score, report: evalOut.report } },
          );
        }

        notify(96, 'publishing', 'Publishing validated media artifact...', 'media.render.progress');
        const ext = path.extname(renderOut.stagedVideoPath) || `.${currentValidated.spec.export.container}`;
        const published = await this.storage.publishArtifactFromFile({
          tenantId,
          projectId,
          jobId,
          stagedFilePath: renderOut.stagedVideoPath,
          kind: currentValidated.spec.tracks.video.length > 0 ? 'video' : 'audio',
          extension: ext,
          mimeType: ext === '.mp3' ? 'audio/mpeg' : 'video/mp4',
          durationSeconds: evalOut.manifest.durationSeconds,
          resolution:
            evalOut.manifest.width && evalOut.manifest.height
              ? `${evalOut.manifest.width}x${evalOut.manifest.height}`
              : `${currentValidated.spec.resolution.width}x${currentValidated.spec.resolution.height}`,
          codec: evalOut.manifest.videoCodec || evalOut.manifest.audioCodec || currentValidated.spec.export.video_codec,
          qaScore: evalOut.report.total_score,
        });

        finalQaReport = {
          ...evalOut.report,
          artifact_id: published.artifact.id,
        };
        finalArtifact = {
          ...published.artifact,
          qaReport: finalQaReport,
        };

        await this.metadataStore.saveQAReport(tenantId, finalQaReport);
        await this.metadataStore.saveArtifact(finalArtifact);

        this.events.publish({
          eventType: 'media.artifact.published',
          tenantId,
          projectId,
          jobId,
          correlationId,
          progress: 100,
          stage: 'completed',
          payload: {
            artifactId: finalArtifact.id,
            qaScore: finalQaReport.total_score,
            repaired,
          },
        });
        this.events.publish({
          eventType: 'media.render.completed',
          tenantId,
          projectId,
          jobId,
          correlationId,
          progress: 100,
          stage: 'completed',
          payload: { artifactId: finalArtifact.id },
        });
        break;
      } finally {
        this.storage.cleanupStagingDir(renderOut.stagingDir);
      }
    }

    if (!finalArtifact || !finalQaReport) {
      throw new MediaEngineError('OUTPUT_CORRUPTION', 'Render lifecycle finished without a validated artifact');
    }

    const outputContract: RenderOutputContract = {
      status: 'completed',
      artifact_id: finalArtifact.id,
      preview_url: finalArtifact.downloadUrl,
      duration_seconds: finalArtifact.durationSeconds,
      resolution: finalArtifact.resolution,
      codec: finalArtifact.codec,
      qa_score: finalQaReport.total_score,
      warnings: finalQaReport.warnings,
      revision_required: finalQaReport.revision_required,
      qa_report: finalQaReport,
    };

    return {
      artifact: finalArtifact,
      qaReport: finalQaReport,
      outputContract,
      repaired,
      appliedFixes,
    };
  }
}
