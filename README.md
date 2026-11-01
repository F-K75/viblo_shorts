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
* Runs as a **single instance** (per-user JSON shards in `/data/projects`). PostgreSQL replaces this in Phase 2.
* `TRUST_PROXY` is **required** in production: `none` when clients connect directly, `1` behind one load
  balancer (or proxy CIDRs). `true` is rejected because it lets clients spoof their IP.
* Storage is bounded per guest, per user, for all guests together, globally, and by free disk (see `.env.example`).
* Backups: verified snapshots every `BACKUP_INTERVAL_HOURS` into `BACKUP_DIR` (default `/data/backups`, same
  volume — copy them off-host). Operator CLI:

  ```bash
  npm run backup -- list
  npm run backup -- verify <snapshot>
  npm run backup -- restore <snapshot>   # server must be stopped; current data is snapshotted and moved aside first
  ```

  In Docker, run the restore in a one-off container against the stopped service's volume:
  `docker run --rm -v forge-data:/data forge-studio node --import tsx scripts/backup.ts restore <snapshot> --force`
  (`--force` is needed because the lock was written by a different container; make sure the service is stopped).
* All settings: [.env.example](.env.example).

## Documentation

* [System architecture](docs/SYSTEM_ARCHITECTURE.md) · [Application flow](docs/APPLICATION_FLOW.md)
* [Feature inventory](docs/FEATURE_INVENTORY.md) · [API inventory](docs/API_INVENTORY.md)
* [Data architecture](docs/DATABASE_ARCHITECTURE.md) · [Technical debt](docs/TECHNICAL_DEBT.md)

## Known limitations

* Exports are recorded in the browser in real time (≈1× the Short's length); keep the tab in the foreground.
* Clips sourced from YouTube can't include the original YouTube footage/audio in the export (browser
  limitation and YouTube ToS). Use the SRT/VTT captions from the Publishing Pack instead.
* Narration is included in exports only when server-side Gemini TTS is available.
