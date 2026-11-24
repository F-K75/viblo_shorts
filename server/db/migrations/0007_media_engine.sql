-- Forge Media Engine persistence tables (Phase 4).
-- Stores tenant-isolated media assets, versioned timeline projects, rendered artifacts, QA reports, and idempotency keys.
-- Expand-only so rolling deployments remain backward-compatible with release N-1.
-- forge:backward-compatible

CREATE TABLE IF NOT EXISTS media_assets (
  id                text PRIMARY KEY CHECK (id ~ '^asset_[a-f0-9]{32}$'),
  tenant_id         text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('video', 'audio', 'image', 'subtitle')),
  original_filename text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
  sha256            text NOT NULL,
  doc               jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_assets_tenant_idx ON media_assets (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media_projects (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL,
  title             text NOT NULL,
  timeline_version  integer NOT NULL DEFAULT 0,
  doc               jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_projects_tenant_idx ON media_projects (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS media_artifacts (
  id                text PRIMARY KEY CHECK (id ~ '^artifact_[a-f0-9]{32}$'),
  tenant_id         text NOT NULL,
  project_id        text NOT NULL,
  job_id            text NOT NULL,
  qa_score          integer NOT NULL DEFAULT 0,
  doc               jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_artifacts_tenant_idx ON media_artifacts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_artifacts_job_idx ON media_artifacts (job_id);

CREATE TABLE IF NOT EXISTS media_qa_reports (
  job_id            text PRIMARY KEY,
  tenant_id         text NOT NULL,
  project_id        text NOT NULL,
  total_score       integer NOT NULL,
  passed            boolean NOT NULL,
  doc               jsonb NOT NULL,
  evaluated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_idempotency_keys (
  tenant_id         text NOT NULL,
  idempotency_key   text NOT NULL,
  job_id            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
