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
docker run -p 3000:3000 -e SESSION_SECRET=$(openssl rand -hex 32) -v forge-data:/data forge-studio
```

* Health: `GET /api/health` (liveness + metrics), `GET /api/ready` (storage + ffmpeg).
* Runs as a **single instance** (JSON-file storage in `/data`). Back up the volume.
* Behind a load balancer set `TRUST_PROXY=1`; restrict cross-origin callers with `ALLOWED_ORIGINS`.
* All settings: [.env.example](.env.example).

## Documentation

* [System architecture](docs/SYSTEM_ARCHITECTURE.md) · [Application flow](docs/APPLICATION_FLOW.md)
* [Feature inventory](docs/FEATURE_INVENTORY.md) · [API inventory](docs/API_INVENTORY.md)
* [Data architecture](docs/DATABASE_ARCHITECTURE.md) · [Technical debt](docs/TECHNICAL_DEBT.md)

## Known limitations

* Exports are recorded in the browser in real time (≈1× the Short's length); keep the tab in the foreground.
* For clips sourced from YouTube, upload your own copy of the source video in the export panel (it stays on
  your device) to export real footage + original audio with synced captions. Without it, the export is a
  captions-only preview, because browsers can't record the embedded YouTube player.
* Narration is included in exports only when server-side Gemini TTS is available.
