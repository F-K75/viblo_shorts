# Forge Media Engine — Deployment & Hardening Guide

## 1. Runtime Prerequisites

- **Node.js:** `>= 22`
- **FFmpeg & FFprobe:** Installed in the production image via `apt-get install -y --no-install-recommends ffmpeg` (`Dockerfile`). Custom binary paths may be set via `FFMPEG_PATH` and `FFPROBE_PATH`.
- **Database:** PostgreSQL `>= 14` via `DATABASE_URL` (applies `0007_media_engine.sql` automatically at startup under advisory lock). Single-instance development supports `STORAGE_BACKEND=json`.
- **Object Storage (Optional):** Set `MEDIA_S3_BUCKET`, `MEDIA_S3_PREFIX`, `S3_REGION`, and `S3_ENDPOINT` to mirror immutable assets and validated artifacts to S3-compatible storage alongside local `DATA_DIR/media` caching.

## 2. Hardened Container Execution

Run render-capable instances with non-root user, dropped Linux capabilities, no privilege escalation, read-only root filesystem, bounded memory/CPU, and no external network egress from isolated worker pools if desired:

```bash
docker build -t forge-studio:media-v1 .

docker run -d \
  --name forge-studio \
  -p 3000:3000 \
  --user node \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --memory=2g \
  --cpus=2 \
  --pids-limit=256 \
  -v forge-data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e TRUST_PROXY=1 \
  -e DATABASE_URL="postgres://..." \
  -e MAX_CONCURRENT_RENDERS=2 \
  -e MEDIA_MAX_THREADS=2 \
  forge-studio:media-v1
```

> **Never** mount `/var/run/docker.sock` into the container.

## 3. Environment Variables (`server/media_engine/config.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `FFMPEG_PATH` | Auto-detected | Path to `ffmpeg` binary |
| `FFPROBE_PATH` | Auto-detected | Path to `ffprobe` binary (falls back to `ffmpeg` stream inspector if unset) |
| `MEDIA_MAX_THREADS` | `2` | `-threads` limit per FFmpeg subprocess |
| `MEDIA_MAX_DURATION_S` | `300` | Maximum derived timeline duration in seconds |
| `MEDIA_MAX_ASSET_BYTES` | `262144000` (250 MB) | Per-asset upload cap |
| `MEDIA_MAX_TENANT_BYTES` | `2147483648` (2 GB) | Per-tenant media storage quota |
| `MEDIA_RENDER_TIMEOUT_MAX_MS` | `600000` (10 min) | Hard `SIGKILL` timeout for a render pass |
| `MEDIA_S3_BUCKET` | unset (local) | Optional S3 bucket for durable multi-instance asset/artifact storage |
