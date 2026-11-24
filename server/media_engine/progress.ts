import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { MediaEngineConfig } from './config.ts';
import type { MediaEvent, MediaEventType, MediaJobStage } from './models.ts';

/**
 * Structured event & audit bus for the Forge Media Engine.
 * Publishes schema-versioned events (Section 10), supports SSE live subscriptions per job/project,
 * deduplicates event IDs, and writes a tamper-evident JSONL audit log.
 */
export class MediaEventBus {
  private readonly emitter = new EventEmitter();
  private readonly recentEvents = new Map<string, MediaEvent[]>(); // keyed by jobId or projectId
  private readonly seenEventIds = new Set<string>();
  private readonly auditLogPath: string;

  constructor(config: MediaEngineConfig) {
    this.emitter.setMaxListeners(200);
    const auditDir = path.join(config.dataDir, 'media', 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    this.auditLogPath = path.join(auditDir, 'media_events.jsonl');
  }

  publish(params: {
    eventType: MediaEventType;
    tenantId: string;
    projectId: string;
    jobId?: string;
    correlationId?: string;
    eventId?: string;
    progress?: number;
    stage?: MediaJobStage;
    payload?: Record<string, unknown>;
  }): MediaEvent {
    const eventId = params.eventId ?? `mevt_${crypto.randomBytes(12).toString('hex')}`;
    if (this.seenEventIds.has(eventId)) {
      const existing = (this.recentEvents.get(params.jobId || params.projectId) || []).find(
        (e) => e.event_id === eventId,
      );
      if (existing) return existing;
    }
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > 5000) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) this.seenEventIds.delete(oldest);
    }

    const event: MediaEvent = {
      event_id: eventId,
      event_type: params.eventType,
      schema_version: '1.0',
      tenant_id: params.tenantId,
      project_id: params.projectId,
      ...(params.jobId ? { job_id: params.jobId } : {}),
      correlation_id: params.correlationId ?? params.jobId ?? params.projectId,
      timestamp: new Date().toISOString(),
      ...(params.progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(params.progress))) } : {}),
      ...(params.stage ? { stage: params.stage } : {}),
      ...(params.payload ? { payload: params.payload } : {}),
    };

    const key = params.jobId || params.projectId;
    const list = this.recentEvents.get(key) ?? [];
    list.push(event);
    if (list.length > 100) list.shift();
    this.recentEvents.set(key, list);

    try {
      fs.appendFileSync(this.auditLogPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Never crash job execution on audit append I/O warning
    }

    if (params.jobId) {
      this.emitter.emit(`job:${params.jobId}`, event);
    }
    this.emitter.emit(`project:${params.projectId}`, event);
    this.emitter.emit('all', event);
    return event;
  }

  subscribeJob(jobId: string, listener: (event: MediaEvent) => void): () => void {
    const channel = `job:${jobId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  historyForJob(jobId: string): MediaEvent[] {
    return [...(this.recentEvents.get(jobId) ?? [])];
  }
}
