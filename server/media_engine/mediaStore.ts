import fs from 'fs';
import path from 'path';
import type pg from 'pg';
import { readJsonFile, writeJsonFileAtomic } from '../lib/storage.ts';
import { MediaEngineError } from './exceptions.ts';
import type {
  MediaArtifactRecord,
  MediaAssetRecord,
  MediaProjectRecord,
  QAReport,
} from './models.ts';

export interface MediaMetadataStore {
  readonly kind: 'json' | 'postgres';
  saveAsset(asset: MediaAssetRecord): Promise<void>;
  getAsset(id: string, tenantId?: string): Promise<MediaAssetRecord | null>;
  listAssets(tenantId: string, limit?: number): Promise<MediaAssetRecord[]>;

  saveProject(project: MediaProjectRecord): Promise<void>;
  getProject(id: string, tenantId?: string): Promise<MediaProjectRecord | null>;
  listProjects(tenantId: string, limit?: number): Promise<MediaProjectRecord[]>;

  saveArtifact(artifact: MediaArtifactRecord): Promise<void>;
  getArtifact(id: string, tenantId?: string): Promise<MediaArtifactRecord | null>;
  listArtifactsByProject(projectId: string, tenantId: string): Promise<MediaArtifactRecord[]>;

  saveQAReport(tenantId: string, report: QAReport): Promise<void>;
  getQAReportByJob(jobId: string, tenantId?: string): Promise<QAReport | null>;

  lookupIdempotencyJob(tenantId: string, key: string): Promise<string | null>;
  recordIdempotencyJob(tenantId: string, key: string, jobId: string): Promise<string>;
}

interface JsonMediaState {
  assets: Record<string, MediaAssetRecord>;
  projects: Record<string, MediaProjectRecord>;
  artifacts: Record<string, MediaArtifactRecord>;
  qaReports: Record<string, { tenantId: string; report: QAReport }>;
  idempotency: Record<string, string>;
}

const EMPTY_STATE: JsonMediaState = {
  assets: {},
  projects: {},
  artifacts: {},
  qaReports: {},
  idempotency: {},
};

/**
 * Atomic JSON file metadata store (`DATA_DIR/media_metadata.json`, covered by `STORE_ENTRIES` snapshots).
 */
export class JsonMediaMetadataStore implements MediaMetadataStore {
  readonly kind = 'json' as const;
  private readonly filePath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(dataDir, 'media_metadata.json');
  }

  private read(): JsonMediaState {
    const loaded = readJsonFile<Partial<JsonMediaState>>(this.filePath, EMPTY_STATE);
    return {
      assets: loaded.assets ?? {},
      projects: loaded.projects ?? {},
      artifacts: loaded.artifacts ?? {},
      qaReports: loaded.qaReports ?? {},
      idempotency: loaded.idempotency ?? {},
    };
  }

  private write(state: JsonMediaState): void {
    writeJsonFileAtomic(this.filePath, state, 2);
  }

  async saveAsset(asset: MediaAssetRecord): Promise<void> {
    const s = this.read();
    const existing = s.assets[asset.id];
    if (existing && existing.tenantId !== asset.tenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'Asset belongs to another tenant', { httpStatus: 403 });
    }
    s.assets[asset.id] = asset;
    this.write(s);
  }

  async getAsset(id: string, tenantId?: string): Promise<MediaAssetRecord | null> {
    const s = this.read();
    const found = s.assets[id] ?? null;
    if (!found) return null;
    if (tenantId !== undefined && found.tenantId !== tenantId) return null;
    return found;
  }

  async listAssets(tenantId: string, limit = 100): Promise<MediaAssetRecord[]> {
    const s = this.read();
    return Object.values(s.assets)
      .filter((a) => a.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async saveProject(project: MediaProjectRecord): Promise<void> {
    const s = this.read();
    const existing = s.projects[project.id];
    if (existing && existing.tenantId !== project.tenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'Project belongs to another tenant', { httpStatus: 404 });
    }
    s.projects[project.id] = project;
    this.write(s);
  }

  async getProject(id: string, tenantId?: string): Promise<MediaProjectRecord | null> {
    const s = this.read();
    const found = s.projects[id] ?? null;
    if (!found) return null;
    if (tenantId !== undefined && found.tenantId !== tenantId) return null;
    return found;
  }

  async listProjects(tenantId: string, limit = 100): Promise<MediaProjectRecord[]> {
    const s = this.read();
    return Object.values(s.projects)
      .filter((p) => p.tenantId === tenantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async saveArtifact(artifact: MediaArtifactRecord): Promise<void> {
    const s = this.read();
    const existing = s.artifacts[artifact.id];
    if (existing && existing.tenantId !== artifact.tenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'Artifact belongs to another tenant', { httpStatus: 403 });
    }
    s.artifacts[artifact.id] = artifact;
    this.write(s);
  }

  async getArtifact(id: string, tenantId?: string): Promise<MediaArtifactRecord | null> {
    const s = this.read();
    const found = s.artifacts[id] ?? null;
    if (!found) return null;
    if (tenantId !== undefined && found.tenantId !== tenantId) return null;
    return found;
  }

  async listArtifactsByProject(projectId: string, tenantId: string): Promise<MediaArtifactRecord[]> {
    const s = this.read();
    return Object.values(s.artifacts)
      .filter((a) => a.projectId === projectId && a.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveQAReport(tenantId: string, report: QAReport): Promise<void> {
    const s = this.read();
    const existing = s.qaReports[report.job_id];
    if (existing && existing.tenantId !== tenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'QA report belongs to another tenant', { httpStatus: 403 });
    }
    s.qaReports[report.job_id] = { tenantId, report };
    this.write(s);
  }

  async getQAReportByJob(jobId: string, tenantId?: string): Promise<QAReport | null> {
    const s = this.read();
    const entry = s.qaReports[jobId];
    if (!entry) return null;
    if (tenantId !== undefined && entry.tenantId !== tenantId) return null;
    return entry.report;
  }

  async lookupIdempotencyJob(tenantId: string, key: string): Promise<string | null> {
    const s = this.read();
    return s.idempotency[`${tenantId}:${key}`] ?? null;
  }

  async recordIdempotencyJob(tenantId: string, key: string, jobId: string): Promise<string> {
    const s = this.read();
    const compound = `${tenantId}:${key}`;
    if (s.idempotency[compound]) return s.idempotency[compound];
    s.idempotency[compound] = jobId;
    this.write(s);
    return jobId;
  }
}

/**
 * Multi-instance PostgreSQL metadata store backed by `0007_media_engine.sql`.
 * Enforces strict cross-tenant conflict protection across assets, projects, artifacts, and QA reports.
 */
export class PostgresMediaMetadataStore implements MediaMetadataStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  async saveAsset(asset: MediaAssetRecord): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO media_assets (id, tenant_id, kind, original_filename, mime_type, size_bytes, sha256, doc, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
       ON CONFLICT (id) DO UPDATE
         SET doc = EXCLUDED.doc
       WHERE media_assets.tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [
        asset.id,
        asset.tenantId,
        asset.kind,
        asset.originalFilename,
        asset.mimeType,
        asset.sizeBytes,
        asset.sha256,
        JSON.stringify(asset),
        asset.createdAt,
      ],
    );
    if (res.rowCount === 0) {
      throw new MediaEngineError('ASSET_ERROR', 'Asset belongs to another tenant', { httpStatus: 403 });
    }
  }

  async getAsset(id: string, tenantId?: string): Promise<MediaAssetRecord | null> {
    const res =
      tenantId !== undefined
        ? await this.pool.query('SELECT doc FROM media_assets WHERE id = $1 AND tenant_id = $2', [id, tenantId])
        : await this.pool.query('SELECT doc FROM media_assets WHERE id = $1', [id]);
    return (res.rows[0]?.doc as MediaAssetRecord | undefined) ?? null;
  }

  async listAssets(tenantId: string, limit = 100): Promise<MediaAssetRecord[]> {
    const res = await this.pool.query(
      'SELECT doc FROM media_assets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return res.rows.map((r: { doc: MediaAssetRecord }) => r.doc);
  }

  async saveProject(project: MediaProjectRecord): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO media_projects (id, tenant_id, title, timeline_version, doc, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             timeline_version = EXCLUDED.timeline_version,
             doc = EXCLUDED.doc,
             updated_at = EXCLUDED.updated_at
       WHERE media_projects.tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [
        project.id,
        project.tenantId,
        project.title,
        project.timelineVersion,
        JSON.stringify(project),
        project.createdAt,
        project.updatedAt,
      ],
    );
    if (res.rowCount === 0) {
      throw new MediaEngineError('ASSET_ERROR', 'Project belongs to another tenant', { httpStatus: 404 });
    }
  }

  async getProject(id: string, tenantId?: string): Promise<MediaProjectRecord | null> {
    const res =
      tenantId !== undefined
        ? await this.pool.query('SELECT doc FROM media_projects WHERE id = $1 AND tenant_id = $2', [id, tenantId])
        : await this.pool.query('SELECT doc FROM media_projects WHERE id = $1', [id]);
    return (res.rows[0]?.doc as MediaProjectRecord | undefined) ?? null;
  }

  async listProjects(tenantId: string, limit = 100): Promise<MediaProjectRecord[]> {
    const res = await this.pool.query(
      'SELECT doc FROM media_projects WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return res.rows.map((r: { doc: MediaProjectRecord }) => r.doc);
  }

  async saveArtifact(artifact: MediaArtifactRecord): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO media_artifacts (id, tenant_id, project_id, job_id, qa_score, doc, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (id) DO UPDATE
         SET qa_score = EXCLUDED.qa_score,
             doc = EXCLUDED.doc
       WHERE media_artifacts.tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [
        artifact.id,
        artifact.tenantId,
        artifact.projectId,
        artifact.jobId,
        artifact.qaScore,
        JSON.stringify(artifact),
        artifact.createdAt,
      ],
    );
    if (res.rowCount === 0) {
      throw new MediaEngineError('ASSET_ERROR', 'Artifact belongs to another tenant', { httpStatus: 403 });
    }
  }

  async getArtifact(id: string, tenantId?: string): Promise<MediaArtifactRecord | null> {
    const res =
      tenantId !== undefined
        ? await this.pool.query('SELECT doc FROM media_artifacts WHERE id = $1 AND tenant_id = $2', [id, tenantId])
        : await this.pool.query('SELECT doc FROM media_artifacts WHERE id = $1', [id]);
    return (res.rows[0]?.doc as MediaArtifactRecord | undefined) ?? null;
  }

  async listArtifactsByProject(projectId: string, tenantId: string): Promise<MediaArtifactRecord[]> {
    const res = await this.pool.query(
      'SELECT doc FROM media_artifacts WHERE project_id = $1 AND tenant_id = $2 ORDER BY created_at DESC',
      [projectId, tenantId],
    );
    return res.rows.map((r: { doc: MediaArtifactRecord }) => r.doc);
  }

  async saveQAReport(tenantId: string, report: QAReport): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO media_qa_reports (job_id, tenant_id, project_id, total_score, passed, doc, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (job_id) DO UPDATE
         SET total_score = EXCLUDED.total_score,
             passed = EXCLUDED.passed,
             doc = EXCLUDED.doc,
             evaluated_at = EXCLUDED.evaluated_at
       WHERE media_qa_reports.tenant_id = EXCLUDED.tenant_id
       RETURNING job_id`,
      [
        report.job_id,
        tenantId,
        report.project_id,
        report.total_score,
        report.passed,
        JSON.stringify(report),
        report.evaluated_at,
      ],
    );
    if (res.rowCount === 0) {
      throw new MediaEngineError('ASSET_ERROR', 'QA report belongs to another tenant', { httpStatus: 403 });
    }
  }

  async getQAReportByJob(jobId: string, tenantId?: string): Promise<QAReport | null> {
    const res =
      tenantId !== undefined
        ? await this.pool.query('SELECT doc FROM media_qa_reports WHERE job_id = $1 AND tenant_id = $2', [jobId, tenantId])
        : await this.pool.query('SELECT doc FROM media_qa_reports WHERE job_id = $1', [jobId]);
    return (res.rows[0]?.doc as QAReport | undefined) ?? null;
  }

  async lookupIdempotencyJob(tenantId: string, key: string): Promise<string | null> {
    const res = await this.pool.query(
      'SELECT job_id FROM media_idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key],
    );
    return (res.rows[0]?.job_id as string | undefined) ?? null;
  }

  async recordIdempotencyJob(tenantId: string, key: string, jobId: string): Promise<string> {
    const res = await this.pool.query(
      `INSERT INTO media_idempotency_keys (tenant_id, idempotency_key, job_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING job_id`,
      [tenantId, key, jobId],
    );
    return res.rows[0].job_id as string;
  }
}
