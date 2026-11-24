import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaEngineError } from '../server/media_engine/exceptions.ts';
import {
  JsonMediaMetadataStore,
  PostgresMediaMetadataStore,
  type MediaMetadataStore,
} from '../server/media_engine/mediaStore.ts';
import type {
  MediaArtifactRecord,
  MediaAssetRecord,
  MediaProjectRecord,
  QAReport,
} from '../server/media_engine/models.ts';
import { migrate } from '../server/db/migrate.ts';
import { createTestDatabase, pgSkip } from './helpers/pg.ts';

const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function runMediaMetadataContractSuite(makeStore: () => Promise<MediaMetadataStore>) {
  const store = await makeStore();
  const now = new Date().toISOString();

  // 1. Asset CRUD + tenant isolation + cross-tenant conflict protection
  const assetA: MediaAssetRecord = {
    id: 'asset_0000000000000000000000000000000a',
    tenantId: 'tenant_1',
    kind: 'video',
    originalFilename: 'a.mp4',
    mimeType: 'video/mp4',
    extension: '.mp4',
    sizeBytes: 4096,
    sha256: 'a'.repeat(64),
    storageBackend: 'local',
    storageKey: 't1/a.mp4',
    immutable: true,
    createdAt: now,
  };
  await store.saveAsset(assetA);
  assert.equal((await store.getAsset(assetA.id, 'tenant_1'))?.originalFilename, 'a.mp4');
  assert.equal(await store.getAsset(assetA.id, 'tenant_2'), null);
  assert.equal((await store.listAssets('tenant_1')).length, 1);
  assert.equal((await store.listAssets('tenant_2')).length, 0);

  await assert.rejects(
    () => store.saveAsset({ ...assetA, tenantId: 'tenant_2' }),
    (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
  );

  // 2. Project CRUD + cross-tenant conflict protection
  const projectA: MediaProjectRecord = {
    id: 'mproj_00000000000000000000000a',
    tenantId: 'tenant_1',
    title: 'Campaign A',
    brief: 'Fast reel',
    format: 'instagram_reel',
    assetIds: [assetA.id],
    timeline: null,
    timelineVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveProject(projectA);
  assert.equal((await store.getProject(projectA.id, 'tenant_1'))?.title, 'Campaign A');
  assert.equal(await store.getProject(projectA.id, 'tenant_2'), null);

  await assert.rejects(
    () => store.saveProject({ ...projectA, tenantId: 'tenant_2', title: 'Hijack' }),
    (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
  );

  // 3. Artifact CRUD + cross-tenant conflict protection
  const artifactA: MediaArtifactRecord = {
    id: 'artifact_0000000000000000000000000000000a',
    tenantId: 'tenant_1',
    projectId: projectA.id,
    jobId: 'render_aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'video',
    filename: 'artifact_0000000000000000000000000000000a.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 8192,
    sha256: 'b'.repeat(64),
    storageBackend: 'local',
    storageKey: 't1/art.mp4',
    downloadUrl: '/api/v1/media/artifacts/artifact_0000000000000000000000000000000a/download',
    durationSeconds: 10,
    resolution: '1080x1920',
    codec: 'h264',
    qaScore: 95,
    createdAt: now,
  };
  await store.saveArtifact(artifactA);
  assert.equal((await store.getArtifact(artifactA.id, 'tenant_1'))?.qaScore, 95);
  assert.equal(await store.getArtifact(artifactA.id, 'tenant_2'), null);
  assert.equal((await store.listArtifactsByProject(projectA.id, 'tenant_1')).length, 1);
  assert.equal((await store.listArtifactsByProject(projectA.id, 'tenant_2')).length, 0);

  await assert.rejects(
    () => store.saveArtifact({ ...artifactA, tenantId: 'tenant_2', qaScore: 10 }),
    (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
  );

  // 4. QA Report CRUD + cross-tenant conflict protection
  const qaA: QAReport = {
    job_id: 'render_aaaaaaaaaaaaaaaaaaaaaaaa',
    project_id: projectA.id,
    artifact_id: artifactA.id,
    total_score: 95,
    band: 'publish_ready',
    passed: true,
    revision_required: false,
    dimensions: {
      technical_integrity: 25,
      visual_quality: 25,
      audio_quality: 18,
      editing_quality: 18,
      creative_compliance: 9,
    },
    metrics: {
      black_frame_intervals: [],
      total_black_duration: 0,
      freeze_intervals: [],
      total_freeze_duration: 0,
      audio_peak_db: -3.2,
      audio_rms_db: -16.1,
      audio_clipping_detected: false,
      audio_silent_detected: false,
      decode_errors: 0,
      expected_duration_seconds: 10,
      actual_duration_seconds: 10,
      duration_drift_seconds: 0,
      av_sync_drift_seconds: 0,
      subtitle_timing_errors: 0,
    },
    warnings: [],
    failures: [],
    repair_actions: [],
    evaluated_at: now,
  };
  await store.saveQAReport('tenant_1', qaA);
  assert.equal((await store.getQAReportByJob(qaA.job_id, 'tenant_1'))?.total_score, 95);
  assert.equal(await store.getQAReportByJob(qaA.job_id, 'tenant_2'), null);

  await assert.rejects(
    () => store.saveQAReport('tenant_2', { ...qaA, total_score: 0 }),
    (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
  );

  // 5. Idempotency key deduplication under concurrent writes
  const winners = await Promise.all([
    store.recordIdempotencyJob('tenant_1', 'idem-1', 'job_first'),
    store.recordIdempotencyJob('tenant_1', 'idem-1', 'job_second'),
  ]);
  assert.equal(winners[0], winners[1]);
  assert.equal(await store.lookupIdempotencyJob('tenant_1', 'idem-1'), winners[0]);
  assert.equal(await store.lookupIdempotencyJob('tenant_2', 'idem-1'), null);
}

describe('Forge Media Engine — Dual Metadata Store Contract Parity', () => {
  test('JsonMediaMetadataStore satisfies full contract and cross-tenant guards', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-json-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    await runMediaMetadataContractSuite(async () => new JsonMediaMetadataStore(dir));
    assert.ok(fs.existsSync(path.join(dir, 'media_metadata.json')));
  });

  test('PostgresMediaMetadataStore (0007_media_engine.sql) satisfies full contract and cross-tenant guards', { skip: pgSkip }, async () => {
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    await migrate(db.pool);
    await runMediaMetadataContractSuite(async () => new PostgresMediaMetadataStore(db.pool));
  });
});
