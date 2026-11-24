import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MediaEngineConfig } from './config.ts';
import { MediaEngineError } from './exceptions.ts';
import {
  isValidArtifactId,
  isValidAssetId,
  type MediaArtifactRecord,
  type MediaAssetKind,
  type MediaAssetRecord,
} from './models.ts';

const SAFE_EXT_BY_KIND: Record<MediaAssetKind, readonly string[]> = {
  video: ['.mp4', '.mov', '.mkv', '.webm', '.m4v'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
  image: ['.jpg', '.jpeg', '.png', '.webp'],
  subtitle: ['.srt', '.vtt'],
};

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
};

export function inferAssetKindFromExtension(filename: string): { kind: MediaAssetKind; ext: string; mimeType: string } {
  const ext = path.extname(path.basename(filename || '')).toLowerCase();
  for (const [kind, exts] of Object.entries(SAFE_EXT_BY_KIND) as Array<[MediaAssetKind, readonly string[]]>) {
    if (exts.includes(ext)) {
      return { kind, ext, mimeType: MIME_BY_EXT[ext] || 'application/octet-stream' };
    }
  }
  throw new MediaEngineError('ASSET_ERROR', `Unsupported media file extension: "${ext || '(none)'}"`, {
    details: { extension: ext, supported: SAFE_EXT_BY_KIND },
  });
}

function tenantDirKey(tenantId: string): string {
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new MediaEngineError('ASSET_ERROR', 'Missing tenant/user identity for media storage');
  }
  return crypto.createHash('sha256').update(tenantId).digest('hex').slice(0, 24);
}

/**
 * Tenant-scoped, symlink-safe, immutable media asset and artifact storage manager.
 * Enforces opaque IDs, symlink/path confinement, `0o444` immutability, canonical MIME types,
 * and SHA-256 checksum verification on S3 hydration.
 */
export class MediaStorage {
  readonly rootDir: string;
  readonly assetsDir: string;
  readonly artifactsDir: string;
  readonly stagingRootDir: string;
  private readonly s3Client: S3Client | null;

  constructor(private readonly config: MediaEngineConfig) {
    this.rootDir = path.resolve(config.dataDir, 'media');
    this.assetsDir = path.join(this.rootDir, 'assets');
    this.artifactsDir = path.join(this.rootDir, 'artifacts');
    this.stagingRootDir = path.join(this.rootDir, 'staging');
    fs.mkdirSync(this.assetsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.artifactsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.stagingRootDir, { recursive: true, mode: 0o700 });

    this.s3Client = config.s3Bucket
      ? new S3Client({
          region: config.s3Region,
          ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        })
      : null;
  }

  newAssetId(): string {
    return `asset_${crypto.randomBytes(16).toString('hex')}`;
  }

  newArtifactId(): string {
    return `artifact_${crypto.randomBytes(16).toString('hex')}`;
  }

  private assertContainedAndNotSymlink(targetPath: string, baseDir: string): string {
    const resolvedBase = fs.realpathSync(baseDir);
    const parentDir = path.dirname(targetPath);
    if (fs.existsSync(parentDir)) {
      const parentStat = fs.lstatSync(parentDir);
      if (parentStat.isSymbolicLink()) {
        throw new MediaEngineError('ASSET_ERROR', 'Symlinked directory rejected in media storage');
      }
    }
    if (fs.existsSync(targetPath)) {
      const st = fs.lstatSync(targetPath);
      if (st.isSymbolicLink()) {
        throw new MediaEngineError('ASSET_ERROR', 'Symlinked media file rejected');
      }
    }
    const resolvedTarget = fs.existsSync(targetPath)
      ? fs.realpathSync(targetPath)
      : path.join(fs.realpathSync(parentDir), path.basename(targetPath));
    const rel = path.relative(resolvedBase, resolvedTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new MediaEngineError('ASSET_ERROR', 'Path traversal outside authorized media directory blocked');
    }
    return resolvedTarget;
  }

  tenantUsageBytes(tenantId: string): number {
    const tKey = tenantDirKey(tenantId);
    let total = 0;
    for (const base of [this.assetsDir, this.artifactsDir]) {
      const dir = path.join(base, tKey);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        try {
          const st = fs.lstatSync(full);
          if (st.isFile() && !st.isSymbolicLink()) total += st.size;
        } catch {
          // ignore concurrent cleanup
        }
      }
    }
    return total;
  }

  async registerAssetFromBuffer(params: {
    tenantId: string;
    originalFilename: string;
    data: Buffer;
    kind?: MediaAssetKind;
  }): Promise<{ record: MediaAssetRecord; localPath: string }> {
    const { tenantId, originalFilename, data } = params;
    if (!Buffer.isBuffer(data) || data.byteLength === 0) {
      throw new MediaEngineError('ASSET_ERROR', 'Asset payload cannot be empty');
    }
    if (data.byteLength > this.config.maxAssetBytes) {
      throw new MediaEngineError(
        'RESOURCE_LIMIT',
        `Asset size (${data.byteLength} bytes) exceeds maximum allowed (${this.config.maxAssetBytes} bytes)`,
      );
    }
    const currentUsage = this.tenantUsageBytes(tenantId);
    if (currentUsage + data.byteLength > this.config.maxTenantBytes) {
      throw new MediaEngineError('RESOURCE_LIMIT', 'Tenant media storage quota exceeded');
    }

    const inferred = inferAssetKindFromExtension(originalFilename);
    const kind = params.kind ?? inferred.kind;
    if (!SAFE_EXT_BY_KIND[kind].includes(inferred.ext)) {
      throw new MediaEngineError(
        'ASSET_ERROR',
        `Extension ${inferred.ext} does not match declared asset kind ${kind}`,
      );
    }

    const id = this.newAssetId();
    const tKey = tenantDirKey(tenantId);
    const tenantDir = path.join(this.assetsDir, tKey);
    fs.mkdirSync(tenantDir, { recursive: true, mode: 0o700 });
    this.assertContainedAndNotSymlink(tenantDir, this.assetsDir);

    const filename = `${id}${inferred.ext}`;
    const finalPath = path.join(tenantDir, filename);
    const tmpPath = path.join(tenantDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);

    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    try {
      fs.writeFileSync(tmpPath, data, { mode: 0o600 });
      fs.renameSync(tmpPath, finalPath);
      fs.chmodSync(finalPath, 0o444);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw new MediaEngineError('STORAGE_ERROR', 'Failed to store media asset safely', { cause: err });
    }

    const verifiedPath = this.assertContainedAndNotSymlink(finalPath, this.assetsDir);
    let storageBackend: 'local' | 's3' = 'local';
    let storageKey = `${tKey}/${filename}`;

    // Always use canonical inferred MIME type (never trust user-supplied Content-Type for S3 storage).
    const canonicalMimeType = inferred.mimeType;

    if (this.s3Client && this.config.s3Bucket) {
      const s3Key = `${this.config.s3Prefix}/assets/${storageKey}`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: s3Key,
          Body: data,
          ContentType: canonicalMimeType,
          Metadata: { sha256, tenant: tKey, assetId: id },
        }),
      );
      storageBackend = 's3';
      storageKey = s3Key;
    }

    const cleanOriginalName = path
      .basename(originalFilename)
      .replace(/[^\w.\- ()]/g, '_')
      .slice(0, 120);

    const record: MediaAssetRecord = {
      id,
      tenantId,
      kind,
      originalFilename: cleanOriginalName || filename,
      mimeType: canonicalMimeType,
      extension: inferred.ext,
      sizeBytes: data.byteLength,
      sha256,
      storageBackend,
      storageKey,
      immutable: true,
      createdAt: new Date().toISOString(),
    };

    return { record, localPath: verifiedPath };
  }

  async registerAssetFromFile(params: {
    tenantId: string;
    sourceFilePath: string;
    originalFilename?: string;
    kind?: MediaAssetKind;
  }): Promise<{ record: MediaAssetRecord; localPath: string }> {
    const st = fs.lstatSync(params.sourceFilePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new MediaEngineError('ASSET_ERROR', 'Source media must be a regular non-symlink file');
    }
    if (st.size > this.config.maxAssetBytes) {
      throw new MediaEngineError('RESOURCE_LIMIT', `Asset exceeds max size (${this.config.maxAssetBytes} bytes)`);
    }
    const data = fs.readFileSync(params.sourceFilePath);
    return this.registerAssetFromBuffer({
      tenantId: params.tenantId,
      originalFilename: params.originalFilename ?? path.basename(params.sourceFilePath),
      data,
      kind: params.kind,
    });
  }

  /**
   * Resolves an authorized `MediaAssetRecord` to a verified local path for FFprobe/FFmpeg.
   * Refuses cross-tenant access, invalid IDs, missing files, symlinks, and SHA-256 tampering.
   */
  async resolveAuthorizedAssetPath(asset: MediaAssetRecord, requestingTenantId: string): Promise<string> {
    if (asset.tenantId !== requestingTenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'Unauthorized media asset access', { httpStatus: 403 });
    }
    if (!isValidAssetId(asset.id)) {
      throw new MediaEngineError('ASSET_ERROR', `Invalid asset ID: ${asset.id}`);
    }
    const tKey = tenantDirKey(asset.tenantId);
    const localCandidate = path.join(this.assetsDir, tKey, `${asset.id}${asset.extension}`);

    if (!fs.existsSync(localCandidate) && asset.storageBackend === 's3' && this.s3Client && this.config.s3Bucket) {
      const tenantDir = path.dirname(localCandidate);
      fs.mkdirSync(tenantDir, { recursive: true, mode: 0o700 });
      this.assertContainedAndNotSymlink(tenantDir, this.assetsDir);
      const out = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: asset.storageKey }),
      );
      const bytes = out.Body ? Buffer.from(await out.Body.transformToByteArray()) : Buffer.alloc(0);
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== asset.sha256) {
        throw new MediaEngineError('STORAGE_ERROR', `S3 asset checksum mismatch for ${asset.id}`);
      }
      const tmpHydrate = `${localCandidate}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpHydrate, bytes, { mode: 0o600 });
      fs.renameSync(tmpHydrate, localCandidate);
      fs.chmodSync(localCandidate, 0o444);
    }

    if (!fs.existsSync(localCandidate)) {
      throw new MediaEngineError('ASSET_ERROR', `Asset file missing from storage: ${asset.id}`, { httpStatus: 404 });
    }
    return this.assertContainedAndNotSymlink(localCandidate, this.assetsDir);
  }

  createJobStagingDir(jobId: string): string {
    const safeSuffix = jobId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'job';
    const dir = path.join(this.stagingRootDir, `${safeSuffix}_${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return this.assertContainedAndNotSymlink(dir, this.stagingRootDir);
  }

  cleanupStagingDir(stagingDir: string): void {
    if (!stagingDir) return;
    try {
      const resolvedBase = fs.realpathSync(this.stagingRootDir);
      if (!fs.existsSync(stagingDir)) return;
      const resolvedTarget = fs.realpathSync(stagingDir);
      const rel = path.relative(resolvedBase, resolvedTarget);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel.length > 0) {
        fs.rmSync(resolvedTarget, { recursive: true, force: true });
      }
    } catch {
      // ignore best-effort cleanup
    }
  }

  async publishArtifactFromFile(params: {
    tenantId: string;
    projectId: string;
    jobId: string;
    stagedFilePath: string;
    kind: 'video' | 'audio' | 'thumbnail' | 'subtitles';
    extension: string;
    mimeType: string;
    durationSeconds: number;
    resolution: string;
    codec: string;
    qaScore: number;
  }): Promise<{ artifact: MediaArtifactRecord; localPath: string }> {
    const st = fs.lstatSync(params.stagedFilePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size === 0) {
      throw new MediaEngineError('OUTPUT_CORRUPTION', 'Rendered output file is missing or empty');
    }
    const id = this.newArtifactId();
    const tKey = tenantDirKey(params.tenantId);
    const tenantArtifactDir = path.join(this.artifactsDir, tKey);
    fs.mkdirSync(tenantArtifactDir, { recursive: true, mode: 0o700 });
    this.assertContainedAndNotSymlink(tenantArtifactDir, this.artifactsDir);

    const ext = params.extension.startsWith('.') ? params.extension.toLowerCase() : `.${params.extension.toLowerCase()}`;
    const canonicalMime = MIME_BY_EXT[ext] || params.mimeType || 'video/mp4';
    const filename = `${id}${ext}`;
    const destPath = path.join(tenantArtifactDir, filename);

    const data = fs.readFileSync(params.stagedFilePath);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    fs.writeFileSync(destPath, data, { mode: 0o600 });
    const verifiedPath = this.assertContainedAndNotSymlink(destPath, this.artifactsDir);

    let storageBackend: 'local' | 's3' = 'local';
    let storageKey = `${tKey}/${filename}`;
    if (this.s3Client && this.config.s3Bucket) {
      const s3Key = `${this.config.s3Prefix}/artifacts/${storageKey}`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: s3Key,
          Body: data,
          ContentType: canonicalMime,
          Metadata: { sha256, artifactId: id, jobId: params.jobId },
        }),
      );
      storageBackend = 's3';
      storageKey = s3Key;
    }

    const artifact: MediaArtifactRecord = {
      id,
      tenantId: params.tenantId,
      projectId: params.projectId,
      jobId: params.jobId,
      kind: params.kind,
      filename,
      mimeType: canonicalMime,
      sizeBytes: data.byteLength,
      sha256,
      storageBackend,
      storageKey,
      downloadUrl: `/api/v1/media/artifacts/${id}/download`,
      durationSeconds: params.durationSeconds,
      resolution: params.resolution,
      codec: params.codec,
      qaScore: params.qaScore,
      createdAt: new Date().toISOString(),
    };

    return { artifact, localPath: verifiedPath };
  }

  resolveArtifactPath(artifact: MediaArtifactRecord, requestingTenantId?: string): string {
    if (requestingTenantId !== undefined && artifact.tenantId !== requestingTenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'Unauthorized artifact access', { httpStatus: 403 });
    }
    if (!isValidArtifactId(artifact.id)) {
      throw new MediaEngineError('ASSET_ERROR', `Invalid artifact ID: ${artifact.id}`);
    }
    const ext = path.extname(artifact.filename);
    const tKey = tenantDirKey(artifact.tenantId);
    const candidate = path.join(this.artifactsDir, tKey, `${artifact.id}${ext}`);
    if (!fs.existsSync(candidate)) {
      throw new MediaEngineError('STORAGE_ERROR', `Artifact file not found on disk: ${artifact.id}`, { httpStatus: 404 });
    }
    return this.assertContainedAndNotSymlink(candidate, this.artifactsDir);
  }

  async resolveArtifactPathAsync(artifact: MediaArtifactRecord, requestingTenantId?: string): Promise<string> {
    if (requestingTenantId !== undefined && artifact.tenantId !== requestingTenantId) {
      throw new MediaEngineError('ASSET_ERROR', 'Unauthorized artifact access', { httpStatus: 403 });
    }
    if (!isValidArtifactId(artifact.id)) {
      throw new MediaEngineError('ASSET_ERROR', `Invalid artifact ID: ${artifact.id}`);
    }
    const ext = path.extname(artifact.filename);
    const tKey = tenantDirKey(artifact.tenantId);
    const candidate = path.join(this.artifactsDir, tKey, `${artifact.id}${ext}`);
    if (!fs.existsSync(candidate) && artifact.storageBackend === 's3' && this.s3Client && this.config.s3Bucket) {
      const tenantDir = path.dirname(candidate);
      fs.mkdirSync(tenantDir, { recursive: true, mode: 0o700 });
      this.assertContainedAndNotSymlink(tenantDir, this.artifactsDir);
      const out = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: artifact.storageKey }),
      );
      const bytes = out.Body ? Buffer.from(await out.Body.transformToByteArray()) : Buffer.alloc(0);
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== artifact.sha256) {
        throw new MediaEngineError('STORAGE_ERROR', `S3 artifact checksum mismatch for ${artifact.id}`);
      }
      const tmpHydrate = `${candidate}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpHydrate, bytes, { mode: 0o600 });
      fs.renameSync(tmpHydrate, candidate);
    }
    return this.resolveArtifactPath(artifact, requestingTenantId);
  }
}
