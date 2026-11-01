# Forge Studio

AI studio for vertical (9:16) YouTube Shorts: turn an idea or a YouTube video + transcript into a scripted,
captioned Short with kinetic word-highlight captions, B-roll, optional AI voice and music, then export it.

> Status: see [RELEASE_READINESS_REPORT.md](RELEASE_READINESS_REPORT.md) — **not yet production ready**.

## Quick start (development)

Requirements: Node ≥ 22, [bun](https://bun.sh) (lockfile), `ffmpeg` on `PATH`.

```bash
bun install
cp .env.example .env   # optional: GEMINI_API_KEY, PEXELS_API_KEY
npm run dev            # http://localhost:3000
```

Without `GEMINI_API_KEY` the app still works, using built-in template content that the UI clearly labels as such.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + Vite dev middleware on `:3000` |
| `npm run lint` | Typecheck frontend **and** server |
| `npm test` | Unit + integration tests (boots its own isolated server; needs ffmpeg) |
| `npm run test:e2e` | Playwright browser journey against the production build (`npm run build` first) |
| `npm run test:live` | Real Gemini API tests (skipped unless `GEMINI_API_KEY` is set) |
| `npm run test:load` | Concurrent load test with latency percentiles |
| `npm run build` | Typecheck + production bundle in `dist/` |
| `npm start` | Production server (requires `SESSION_SECRET`) |

## Production

```bash
docker build -t forge-studio .
docker run -p 3000:3000 -e SESSION_SECRET=$(openssl rand -hex 32) -e TRUST_PROXY=none -v forge-data:/data forge-studio
```

* Health: `GET /api/health` (liveness + metrics), `GET /api/ready` (storage + ffmpeg).
* **Storage:** set `DATABASE_URL` (managed PostgreSQL ≥ 14, TLS). Schema migrations run automatically at
  startup (advisory-locked, safe with several instances). Without `DATABASE_URL`, production refuses to start
  unless `STORAGE_BACKEND=json` explicitly selects the single-instance JSON store.
* `TRUST_PROXY` is **required** in production: `none` when clients connect directly, `1` behind one load
  balancer (or proxy CIDRs). `true` is rejected because it lets clients spoof their IP.
* Rate limits, AI quotas, storage quotas and the render queue are shared through the database, so any number
  of instances can run (rendered MP4 files are still per-instance: FS-037).
* **Backups:** encrypted off-site `pg_dump` backups with `Dockerfile.backup` / `npm run db-backup`, plus
  provider PITR — see [docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md) (RPO/RTO, restore, cut-over
  from JSON with `npm run data-migration -- plan|migrate|export`).

### Tests against PostgreSQL

```bash
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' npm test   # + PostgreSQL contract & Phase 2 gate tests
TEST_DATABASE_URL=... TEST_STORAGE_BACKEND=postgres npm test                               # every test server on PostgreSQL
```

Without `TEST_DATABASE_URL` the PostgreSQL tests are reported as **skipped** (not passed); CI sets
`REQUIRE_PG_TESTS=1`, which turns a missing database into a failure. Backup tests need `age` and `pg_dump`.

## Documentation

* [System architecture](docs/SYSTEM_ARCHITECTURE.md) · [Application flow](docs/APPLICATION_FLOW.md)
* [Feature inventory](docs/FEATURE_INVENTORY.md) · [API inventory](docs/API_INVENTORY.md)
* [Data architecture](docs/DATABASE_ARCHITECTURE.md) · [Technical debt](docs/TECHNICAL_DEBT.md)

## Known limitations

* Exports are recorded in the browser in real time (≈1× the Short's length); keep the tab in the foreground.
* Clips sourced from YouTube can't include the original YouTube footage/audio in the export (browser
  limitation and YouTube ToS). Use the SRT/VTT captions from the Publishing Pack instead.
* Narration is included in exports only when server-side Gemini TTS is available.
