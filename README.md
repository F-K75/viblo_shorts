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

## Make a finished video from the command line

```bash
npm run build
npm run make-video -- "5 science-backed habits to fall asleep faster"   # → output/forge_short.mp4
```

Drives the real UI in headless Chromium (guest → idea → script → export) and writes a 1080×1920 H.264/AAC MP4
normalised to YouTube loudness (−14 LUFS). With `GEMINI_API_KEY` set you get an AI-written script and AI voiceover;
with `PEXELS_API_KEY`, real stock footage. Without keys you get the built-in template script on animated
motion-graphics backgrounds with background music.

## Clip a long video (YouTube link + your own copy of the video)

```bash
npm run build
npm run make-clip -- --url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --source my-video.mp4 --transcript transcript.txt --clip 1        # → output/forge_clip_1.mp4
```

* `--transcript`: paste of YouTube's "Show transcript" panel (or any `m:ss` timed text). Without it the server tries the
  video's captions; without AI it then picks clips from the transcript itself (hook, complete sentences, no intro/outro).
* `--source`: your own copy of the full video (e.g. downloaded from YouTube Studio). The browser cannot record
  YouTube's embedded player, so this is what puts real footage and the speaker's audio into the clip. In the app:
  *Canvas & Timeline → Add your video file*. It stays on your device.
* `--clip N` picks the Nth candidate (1 = best), `--fit` letterboxes instead of centre-cropping.
* `--download --i-have-rights` instead of `--source`: fetches just the clip's section from YouTube with
  [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`; needs ffmpeg). Only for videos you own or have
  permission to use — downloading other people's videos breaks YouTube's Terms of Service.

### Optional: YouTube footage download in the app

Off by default. Install `yt-dlp` on the server and set `YOUTUBE_DOWNLOAD_ENABLED=true`. The editor then shows
*Get this clip's footage from YouTube* (after the user confirms they own the video or have permission). Only the clip
section (±15 s) is downloaded, files are visible only to their owner and deleted after `YTDLP_TTL_MIN` (60). Limits:
`YTDLP_MAX_MB` (500), `YTDLP_TIMEOUT_S` (300), `YTDLP_MAX_CONCURRENT` (2), `YTDLP_MAX_SECTION_S` (300); `YTDLP_PATH`
overrides the binary. YouTube may block downloads from cloud/datacenter IPs ("confirm you're not a bot").

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
* **JSON backend snapshots** (`STORAGE_BACKEND=json`, single instance): verified snapshots every
  `BACKUP_INTERVAL_HOURS` into `BACKUP_DIR` (default `/data/backups`, same volume, so copy them off-host).
  Operator CLI:

  ```bash
  npm run backup -- list
  npm run backup -- verify <snapshot>
  npm run backup -- restore <snapshot>   # server must be stopped; all-or-nothing; current data is snapshotted and moved aside first
  npm run backup -- recover              # only if a restore was interrupted: rolls back to the data before it (the server refuses to start until then)
  ```

  In Docker, **stop the service first**, then run the restore in a one-off container against its volume. `--force`
  is needed because the lock was written by the other container, and the tool cannot verify that container is
  stopped:
  `docker run --rm -v forge-data:/data forge-studio node --import tsx scripts/backup.ts restore <snapshot> --force`
* All settings: [.env.example](.env.example).

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
