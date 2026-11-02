-- Forge Studio initial schema (Phase 2). Applied by server/db/migrate.ts inside one transaction.
-- Design notes: docs/ARCHITECTURE_DECISIONS.md (ADR-002, ADR-003).

-- Every identity that owns data. kind: firebase | guest | legacy (pre-auth records without an owner).
-- storage_bytes / project_count are maintained transactionally with project writes so quotas hold
-- under concurrent requests on any number of instances (the row is locked FOR UPDATE per write).
CREATE TABLE users (
  id             text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  kind           text NOT NULL CHECK (kind IN ('firebase', 'guest', 'legacy')),
  storage_bytes  bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  project_count  integer NOT NULL DEFAULT 0 CHECK (project_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_kind_idx ON users (kind);

-- Aggregate storage counters for the guest-pool and global caps ('all', 'guest').
CREATE TABLE storage_totals (
  scope  text PRIMARY KEY CHECK (scope IN ('all', 'guest')),
  bytes  bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0)
);
INSERT INTO storage_totals (scope, bytes) VALUES ('all', 0), ('guest', 0);

-- Projects: the API document is stored in `doc` (jsonb) so the existing API contract is preserved
-- byte-for-byte; id/user_id/title/timestamps are columns for ownership, indexing and listing.
CREATE TABLE projects (
  id          text PRIMARY KEY CHECK (id ~ '^proj_[A-Za-z0-9_-]{1,64}$'),
  user_id     text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  title       text NOT NULL,
  doc         jsonb NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes >= 0),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
-- "My projects" list: WHERE user_id = $1 ORDER BY updated_at DESC
CREATE INDEX projects_user_updated_idx ON projects (user_id, updated_at DESC);

CREATE TABLE subscriptions (
  user_id                       text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  plan                          text NOT NULL CHECK (plan IN ('free', 'pro', 'studio')),
  status                        text NOT NULL DEFAULT 'active',
  monthly_render_minutes_used   numeric(12, 2) NOT NULL DEFAULT 0,
  current_period_end            timestamptz NOT NULL,
  demo                          boolean NOT NULL DEFAULT false,
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- Render jobs. Queue semantics: workers claim with FOR UPDATE SKIP LOCKED (any instance);
-- processing jobs carry worker_id + heartbeat_at so a dead instance's jobs are detected, not guessed.
CREATE TABLE jobs (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress       integer NOT NULL DEFAULT 0,
  step_message   text,
  payload        jsonb,
  result         jsonb,
  error          text,
  worker_id      text,
  heartbeat_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX jobs_user_created_idx ON jobs (user_id, created_at DESC);
-- queue scan + per-user active-job counts touch only active rows
CREATE INDEX jobs_active_idx ON jobs (created_at) WHERE status IN ('queued', 'processing');

-- Daily AI usage per key ('user:<id>' / 'ip:<addr>'). Reserve = conditional upsert (atomic per row).
CREATE TABLE ai_usage_daily (
  day    date NOT NULL,
  key    text NOT NULL,
  count  integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, key)
);

-- Token buckets shared by all instances (per-minute limits). One row per (group, subject).
CREATE TABLE rate_buckets (
  key          text PRIMARY KEY,
  tokens       double precision NOT NULL,
  refilled_at  timestamptz NOT NULL
);
CREATE INDEX rate_buckets_refilled_idx ON rate_buckets (refilled_at);

-- Fixed-window counters (e.g. global guest sign-ups per hour).
CREATE TABLE window_counters (
  key        text NOT NULL,
  window_id  bigint NOT NULL,
  count      integer NOT NULL,
  PRIMARY KEY (key, window_id)
);

-- Audit trail of JSON -> PostgreSQL data migrations (scripts/migrate-json-to-postgres.ts).
CREATE TABLE data_migrations (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,
  source_digest  text NOT NULL,
  snapshot       text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  report         jsonb
);
