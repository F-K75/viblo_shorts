import crypto from 'crypto';
import fs from 'fs';
import type express from 'express';
import type { JobAdmission, JobDenial, Repo, ServerJob } from '../lib/repo.ts';
import { parseRangeHeader, sanitizeString } from '../lib/security.ts';
import type { MediaProductionOrchestrator, QueuedMediaRenderPayload } from '../agents/media/orchestrator.ts';
import { SKILL_ACTIVATION_MATRIX } from '../agents/media/orchestrator.ts';
import { classifyMediaError, MediaEngineError } from '../media_engine/exceptions.ts';
import {
  isValidArtifactId,
  isValidAssetId,
  isValidMediaProjectId,
  type MediaAssetKind,
  type MediaProjectRecord,
  type PresetId,
  type QualityProfile,
} from '../media_engine/models.ts';
import { getExportPreset, listExportPresets } from '../media_engine/presets/index.ts';

export interface MediaRoutesDeps {
  rateLimit: (group: string, maxPerMinute: number, opts?: { ai?: boolean }) => express.RequestHandler;
  uid: (req: express.Request) => string;
  isAdmin: (req: express.Request) => boolean;
  refuseGuestRender: (req: express.Request, res: express.Response) => boolean;
  getRepo: () => Repo;
  getOrchestrator: () => MediaProductionOrchestrator;
  buildJobAdmission: (userId: string, durationS: number) => Promise<JobAdmission>;
  sendDenial: (res: express.Response, denial: JobDenial) => void;
  pumpRenderQueue: () => void;
  cancelRunningProcess: (jobId: string) => void;
}

const MAX_PROJECT_ASSETS = 64;

function normalizeAssetIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter((id: unknown): id is string => isValidAssetId(id));
  return Array.from(new Set(valid)).slice(0, MAX_PROJECT_ASSETS);
}

function sendMediaError(res: express.Response, err: unknown) {
  const classified = classifyMediaError(err);
  return res.status(classified.httpStatus).json(classified.toJSON());
}

/**
 * Registers the Forge Media Engine v1 REST API (`/api/v1/media/*`) + SSE progress endpoint.
 * Server media uploads, FFprobe inspection, planning, and rendering require a signed-in account
 * (`refuseGuestRender`), and AI planning reserves daily AI quota (`{ ai: true }`).
 */
export function registerMediaRoutes(app: express.Express, deps: MediaRoutesDeps): void {
  const {
    rateLimit,
    uid,
    isAdmin,
    refuseGuestRender,
    getRepo,
    getOrchestrator,
    buildJobAdmission,
    sendDenial,
    pumpRenderQueue,
    cancelRunningProcess,
  } = deps;

  app.get('/api/v1/media/presets', rateLimit('media-read', 120), (_req, res) => {
    res.json({
      success: true,
      presets: listExportPresets(),
      skill: SKILL_ACTIVATION_MATRIX,
    });
  });

  app.post('/api/v1/media/assets', rateLimit('media-assets-write', 30), async (req, res) => {
    try {
      if (refuseGuestRender(req, res)) return;
      const body = req.body ?? {};
      const filename = sanitizeString(body.filename || body.originalFilename, 160);
      if (!filename) {
        throw new MediaEngineError('ASSET_ERROR', 'filename is required');
      }
      let data: Buffer;
      if (typeof body.contentBase64 === 'string' && body.contentBase64.length > 0) {
        const cleanB64 = body.contentBase64.replace(/^data:[^;]+;base64,/, '');
        data = Buffer.from(cleanB64, 'base64');
      } else if (typeof body.textContent === 'string' && body.textContent.length > 0) {
        data = Buffer.from(body.textContent, 'utf8');
      } else {
        throw new MediaEngineError('ASSET_ERROR', 'Provide contentBase64 or textContent when registering a media asset');
      }

      const allowedKinds: readonly MediaAssetKind[] = ['video', 'audio', 'image', 'subtitle'];
      const kind = allowedKinds.includes(body.kind) ? (body.kind as MediaAssetKind) : undefined;
      const autoProbe = body.autoProbe !== false;

      const asset = await getOrchestrator().registerAndInspectAsset({
        tenantId: uid(req),
        originalFilename: filename,
        data,
        kind,
        autoProbe,
      });

      res.status(201).json({ success: true, asset });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.get('/api/v1/media/assets', rateLimit('media-read', 120), async (req, res) => {
    try {
      const assets = await getOrchestrator().metadataStore.listAssets(uid(req), 100);
      res.json({ success: true, assets });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.get('/api/v1/media/assets/:id', rateLimit('media-read', 120), async (req, res) => {
    try {
      if (!isValidAssetId(req.params.id)) {
        throw new MediaEngineError('ASSET_ERROR', 'Invalid asset ID format');
      }
      const asset = await getOrchestrator().metadataStore.getAsset(req.params.id, isAdmin(req) ? undefined : uid(req));
      if (!asset) return res.status(404).json({ error: 'Media asset not found', code: 'ASSET_ERROR' });
      res.json({ success: true, asset });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.post('/api/v1/media/probe', rateLimit('media-probe', 40), async (req, res) => {
    try {
      if (refuseGuestRender(req, res)) return;
      const assetId = req.body?.asset_id ?? req.body?.assetId;
      if (!isValidAssetId(assetId)) {
        throw new MediaEngineError('ASSET_ERROR', 'Valid asset_id is required');
      }
      const asset = await getOrchestrator().inspectAssetById(assetId, uid(req));
      res.json({ success: true, asset_id: asset.id, manifest: asset.manifest });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.post('/api/v1/media/projects', rateLimit('media-projects-write', 60), async (req, res) => {
    try {
      if (refuseGuestRender(req, res)) return;
      const orch = getOrchestrator();
      const body = req.body ?? {};
      const title = sanitizeString(body.title, 160) || 'Untitled Media Project';
      const brief = sanitizeString(body.brief, 2000) || title;
      const preset = getExportPreset(body.format ?? body.preset ?? 'instagram_reel');
      const assetIds = normalizeAssetIdList(body.asset_ids ?? body.assetIds);

      for (const id of assetIds) {
        const found = await orch.metadataStore.getAsset(id, uid(req));
        if (!found) {
          throw new MediaEngineError('ASSET_ERROR', `Asset not found: ${id}`, { httpStatus: 404 });
        }
      }

      const now = new Date().toISOString();
      let project: MediaProjectRecord = {
        id: orch.newProjectId(),
        tenantId: uid(req),
        title,
        brief,
        format: preset.id,
        assetIds,
        timeline: null,
        timelineVersion: 0,
        createdAt: now,
        updatedAt: now,
      };
      await orch.metadataStore.saveProject(project);
      orch.events.publish({
        eventType: 'media.project.created',
        tenantId: uid(req),
        projectId: project.id,
        payload: { format: project.format, assetCount: assetIds.length },
      });

      if (body.auto_plan === true && assetIds.length > 0) {
        const planned = await orch.planProjectTimeline({ project, tenantId: uid(req) });
        project = planned.project;
      }

      res.status(201).json({ success: true, project });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.get('/api/v1/media/projects', rateLimit('media-read', 120), async (req, res) => {
    try {
      const projects = await getOrchestrator().metadataStore.listProjects(uid(req), 100);
      res.json({ success: true, projects });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.get('/api/v1/media/projects/:id', rateLimit('media-read', 120), async (req, res) => {
    try {
      if (!isValidMediaProjectId(req.params.id)) {
        return res.status(400).json({ error: 'Invalid media project ID', code: 'TIMELINE_ERROR' });
      }
      const orch = getOrchestrator();
      const project = await orch.metadataStore.getProject(req.params.id, isAdmin(req) ? undefined : uid(req));
      if (!project) return res.status(404).json({ error: 'Media project not found' });
      const artifacts = await orch.metadataStore.listArtifactsByProject(project.id, project.tenantId);
      res.json({ success: true, project, artifacts });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // Explicit AI timeline planning endpoint: reserves daily AI quota (`{ ai: true }`) before calling Gemini.
  app.post('/api/v1/media/projects/:id/plan', rateLimit('media-plan', 15, { ai: true }), async (req, res) => {
    try {
      if (refuseGuestRender(req, res)) return;
      const orch = getOrchestrator();
      const project = await orch.metadataStore.getProject(req.params.id, uid(req));
      if (!project) return res.status(404).json({ error: 'Media project not found' });
      if (typeof req.body?.brief === 'string' && req.body.brief.trim()) {
        project.brief = sanitizeString(req.body.brief, 2000);
      }
      if (Array.isArray(req.body?.asset_ids)) {
        project.assetIds = normalizeAssetIdList(req.body.asset_ids);
      }
      if (req.body?.format) {
        project.format = getExportPreset(req.body.format).id;
      }
      const { project: updated, validated } = await orch.planProjectTimeline({ project, tenantId: uid(req) });
      if (updated.editPlan?.generatedBy === 'gemini') {
        req.aiSucceeded = true;
      }
      res.json({ success: true, project: updated, warnings: validated.warnings });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.put('/api/v1/media/projects/:id/timeline', rateLimit('media-projects-write', 60), async (req, res) => {
    try {
      if (refuseGuestRender(req, res)) return;
      const orch = getOrchestrator();
      const project = await orch.metadataStore.getProject(req.params.id, uid(req));
      if (!project) return res.status(404).json({ error: 'Media project not found' });

      const incomingTimeline = req.body?.timeline ?? req.body;
      const withProjectId = {
        ...(incomingTimeline && typeof incomingTimeline === 'object' ? incomingTimeline : {}),
        project_id: project.id,
      };
      const validated = await orch.validateProjectTimeline(withProjectId, uid(req));

      const updated: MediaProjectRecord = {
        ...project,
        format: validated.spec.format,
        timeline: validated.spec,
        timelineVersion: project.timelineVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      await orch.metadataStore.saveProject(updated);
      orch.events.publish({
        eventType: 'media.timeline.updated',
        tenantId: uid(req),
        projectId: updated.id,
        payload: { timelineVersion: updated.timelineVersion, durationSeconds: validated.derivedDurationSeconds },
      });

      res.json({ success: true, project: updated, warnings: validated.warnings });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.post('/api/v1/media/render', rateLimit('render', 15), async (req, res) => {
    try {
      if (refuseGuestRender(req, res)) return;
      const orch = getOrchestrator();
      const repo = getRepo();
      const userId = uid(req);
      const body = req.body ?? {};

      const idempotencyKeyRaw = req.headers['idempotency-key'] ?? body.idempotency_key;
      const idempotencyKey =
        typeof idempotencyKeyRaw === 'string' && idempotencyKeyRaw.trim().length > 0
          ? sanitizeString(idempotencyKeyRaw, 120)
          : null;

      if (idempotencyKey) {
        const existingJobId = await orch.metadataStore.lookupIdempotencyJob(userId, idempotencyKey);
        if (existingJobId) {
          const existingJob = await repo.getJob(existingJobId);
          if (existingJob && existingJob.userId === userId) {
            return res.status(200).json({
              job_id: existingJob.id,
              status: existingJob.status,
              progress: existingJob.progress,
              stage: existingJob.result?.stage ?? (existingJob.status === 'completed' ? 'completed' : 'initializing'),
              created_at: existingJob.createdAt,
              deduplicated: true,
            });
          }
        }
      }

      const projectId = body.project_id ?? body.projectId;
      if (!isValidMediaProjectId(projectId)) {
        throw new MediaEngineError('TIMELINE_ERROR', 'Valid project_id is required');
      }
      let project = await orch.metadataStore.getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Media project not found', code: 'ASSET_ERROR' });
      }

      const presetObj = body.preset ? getExportPreset(body.preset) : getExportPreset(project.format);
      const qualityAllowed: readonly QualityProfile[] = ['draft', 'standard', 'high'];
      const qualityProfile: QualityProfile = qualityAllowed.includes(body.quality_profile)
        ? body.quality_profile
        : 'high';

      if (!project.timeline) {
        if (project.assetIds.length === 0) {
          throw new MediaEngineError('TIMELINE_ERROR', 'Project has neither a timeline nor media assets to plan from');
        }
        const planned = await orch.planProjectTimeline({ project, tenantId: userId });
        project = planned.project;
      }

      if (
        body.timeline_version !== undefined &&
        Number(body.timeline_version) !== project.timelineVersion
      ) {
        return res.status(409).json({
          error: `Timeline version mismatch (requested ${body.timeline_version}, current is ${project.timelineVersion})`,
          code: 'TIMELINE_ERROR',
        });
      }

      const presetOverridden = presetObj.id !== project.timeline!.format;
      const timelineToRender = {
        ...project.timeline!,
        format: presetObj.id as PresetId,
        resolution: { width: presetObj.width, height: presetObj.height },
        fps: presetObj.fps,
        export: presetOverridden
          ? {
              container: presetObj.container,
              video_codec: presetObj.videoCodec,
              audio_codec: presetObj.audioCodec,
              pixel_format: presetObj.pixelFormat,
              video_bitrate: presetObj.videoBitrate,
              audio_bitrate: presetObj.audioBitrate,
            }
          : project.timeline!.export,
      };
      const validated = await orch.validateProjectTimeline(timelineToRender, userId);

      const jobId = `render_${crypto.randomBytes(12).toString('hex')}`;
      const correlationId = `corr_${crypto.randomBytes(8).toString('hex')}`;
      const renderPayload: QueuedMediaRenderPayload & { duration: number } = {
        projectId: project.id,
        tenantId: userId,
        timelineVersion: project.timelineVersion,
        preset: presetObj.id,
        qualityProfile,
        timeline: validated.spec,
        correlationId,
        duration: validated.derivedDurationSeconds,
      };

      const job: ServerJob = {
        id: jobId,
        userId,
        type: 'media_render',
        status: 'queued',
        progress: 0,
        stepMessage: 'initializing',
        createdAt: new Date().toISOString(),
        payload: renderPayload,
      };

      const admission = await buildJobAdmission(userId, validated.derivedDurationSeconds);
      const denial = await repo.insertJob(job, admission);
      if (denial) return sendDenial(res, denial);

      if (idempotencyKey) {
        await orch.metadataStore.recordIdempotencyJob(userId, idempotencyKey, jobId);
      }

      orch.events.publish({
        eventType: 'media.render.queued',
        tenantId: userId,
        projectId: project.id,
        jobId,
        correlationId,
        progress: 0,
        stage: 'initializing',
      });

      pumpRenderQueue();

      res.status(202).json({
        job_id: job.id,
        status: job.status,
        progress: job.progress,
        stage: 'initializing',
        created_at: job.createdAt,
      });
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  app.get('/api/v1/media/jobs/:id', rateLimit('jobs-read', 240), async (req, res) => {
    const job = await getRepo().getJob(req.params.id);
    if (!job || (job.userId !== uid(req) && !isAdmin(req))) {
      return res.status(404).json({ error: 'Media job not found' });
    }
    res.json({
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.result?.stage ?? job.stepMessage ?? job.status,
      created_at: job.createdAt,
      completed_at: job.completedAt ?? null,
      error: job.error ?? null,
      result: job.result ?? null,
    });
  });

  app.get('/api/v1/media/jobs/:id/events', rateLimit('jobs-read', 120), async (req, res) => {
    const job = await getRepo().getJob(req.params.id);
    if (!job || (job.userId !== uid(req) && !isAdmin(req))) {
      return res.status(404).json({ error: 'Media job not found' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const orch = getOrchestrator();
    for (const past of orch.events.historyForJob(job.id)) {
      res.write(`data: ${JSON.stringify(past)}\n\n`);
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      res.end();
      return;
    }
    const unsub = orch.events.subscribeJob(job.id, (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (
        evt.event_type === 'media.render.completed' ||
        evt.event_type === 'media.render.failed' ||
        evt.event_type === 'media.job.cancelled'
      ) {
        unsub();
        res.end();
      }
    });
    req.on('close', () => unsub());
  });

  app.post('/api/v1/media/jobs/:id/cancel', rateLimit('jobs-write', 60), async (req, res) => {
    const repo = getRepo();
    const job = await repo.getJob(req.params.id);
    if (!job || (job.userId !== uid(req) && !isAdmin(req))) {
      return res.status(404).json({ error: 'Media job not found' });
    }
    const cancelled = await repo.cancelJob(job.id);
    if (!cancelled) {
      return res.status(409).json({ error: `Cannot cancel a job in state ${job.status}` });
    }
    cancelRunningProcess(job.id);
    getOrchestrator().executor.cancel(job.id);
    getOrchestrator().events.publish({
      eventType: 'media.job.cancelled',
      tenantId: job.userId,
      projectId: String(job.payload?.projectId || 'workspace'),
      jobId: job.id,
      stage: 'cancelled',
    });
    res.json({
      job_id: cancelled.id,
      status: cancelled.status,
      stage: 'cancelled',
    });
  });

  app.get('/api/v1/media/jobs/:id/qa', rateLimit('media-read', 120), async (req, res) => {
    const job = await getRepo().getJob(req.params.id);
    if (!job || (job.userId !== uid(req) && !isAdmin(req))) {
      return res.status(404).json({ error: 'Media job not found' });
    }
    const report = await getOrchestrator().metadataStore.getQAReportByJob(
      job.id,
      isAdmin(req) ? undefined : uid(req),
    );
    if (!report) {
      return res.status(404).json({ error: 'QA report not available for this job yet' });
    }
    res.json({ success: true, qa_report: report });
  });

  app.get('/api/v1/media/artifacts/:id', rateLimit('media-read', 120), async (req, res) => {
    if (!isValidArtifactId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid artifact ID', code: 'ASSET_ERROR' });
    }
    const artifact = await getOrchestrator().metadataStore.getArtifact(
      req.params.id,
      isAdmin(req) ? undefined : uid(req),
    );
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    res.json({ success: true, artifact });
  });

  app.get('/api/v1/media/artifacts/:id/download', rateLimit('render-download', 120), async (req, res) => {
    try {
      if (!isValidArtifactId(req.params.id)) {
        return res.status(400).json({ error: 'Invalid artifact ID' });
      }
      const orch = getOrchestrator();
      const artifact = await orch.metadataStore.getArtifact(req.params.id);
      if (!artifact) return res.status(404).json({ error: 'Artifact not found or expired' });
      const filePath = await orch.storage.resolveArtifactPathAsync(artifact);
      const fileSize = fs.statSync(filePath).size;
      const range = parseRangeHeader(req.headers.range, fileSize);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }
      if (range) {
        res.writeHead(206, {
          'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': range.end - range.start + 1,
          'Content-Type': artifact.mimeType,
        });
        fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': artifact.mimeType,
          'Content-Disposition': `inline; filename="${artifact.filename}"`,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      sendMediaError(res, err);
    }
  });
}
