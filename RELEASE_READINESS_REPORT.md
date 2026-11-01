# Forge Studio — Release Readiness Report

**Date:** 2026-10-31 · **Branch:** `claude/dreamy-edison-ql3cqx` · **Environment:** cloud sandbox (4 vCPU, Node 22, ffmpeg, headless Chromium)

## FINAL DECISION: **NOT READY FOR PRODUCTION**

The exploitable security holes and the broken core workflows found in the baseline are fixed and covered by
automated tests. Launch is still blocked by items that could not be validated here or that need product or
infrastructure decisions (see "Release blockers").

---

## 0. Scope reality check

The audit brief describes an AI code-generation platform (workspaces, agents, code editor, builds, teams).
**This repository is an AI YouTube Shorts studio.** None of those features exist in the code, so they were not
tested and are not scored. Everything below was audited against the product that actually exists. I added
no features beyond what the code already promised.

## 1. Test environment limitations (explicit)

| Unavailable | Consequence |
|---|---|
| `GEMINI_API_KEY` (none configured) | **Real LLM output was never observed.** All AI tests exercise the real code path down to the provider call, then the fallback. `tests/llm.live.test.ts` exists and reports **SKIPPED (not passed)** without a key |
| YouTube, Pexels, Mixkit, Unsplash, dicebear, Firebase Auth endpoints (blocked by sandbox egress) | Caption auto-fetch, oEmbed, stock search, remote media and real Firebase sign-in are untested. Firebase **token verification** is tested with locally generated RSA keys |
| Docker daemon (sandbox only) | Not available locally. **Resolved in CI:** the image built and passed the container smoke test (readiness + guest session) in [run 41295088510](https://github.com/F-K75/viblo_shorts/actions/runs/41295088510). `docker-compose.yml` hardening (read-only FS, limits) is still untested |
| GitHub Actions | **Resolved:** first run on PR #1 green — `test` (typecheck, unit/integration, build, Playwright E2E, audit gate) and `docker` passed in [run 41295088510](https://github.com/F-K75/viblo_shorts/actions/runs/41295088510). `live-llm` skipped (runs on pushes to `main` only; needs `GEMINI_API_KEY` secret) |
| Google Drive OAuth | Drive export is untested |

## 2. Scores

| Dimension | Initial | Final | Basis |
|---|---:|---:|---|
| Product functionality | 30 | 62 | Save and export were broken and are now fixed + E2E-tested. Real AI is unverified. YouTube-source export can't include footage |
| Frontend and UX | 50 | 68 | Silent failures replaced by error/notice states; Escape on modals; mobile header fixed; misleading claims removed |
| Backend engineering | 30 | 70 | Validation, error handler, atomic storage, real job queue, timeouts, graceful shutdown, server typechecked in CI |
| AI engineering | 20 | 55 | Timeouts, bounded retries, schema validation, labelled fallbacks, no hallucinated transcripts, token/latency metrics. No real-model evaluation |
| Security | 5 | 72 | P0/P1 fixed (below). Remaining: no CSP, free guest minting, single-tenant JSON store |
| Performance | 45 | 62 | Measured (§6). Vendor chunk split. Export is real-time by design |
| Testing | 15 | 70 | 55 passing + 2 explicitly skipped + 1 browser E2E. Tests import real code. Load script |
| DevOps | 10 | 62 | Dockerfile, compose, CI, readiness probe, env docs, fail-fast secrets. CI and Docker image build + smoke test green on GitHub; no deploy pipeline, monitoring or backups |
| Scalability | 15 | 30 | Bounded queues and caps; still single-process JSON storage and in-memory state |
| Production readiness | 5 | 40 | See blockers |

Initial scores reflect the measured baseline: header-spoofable admin access, silent save failure, an export at one third of its duration with no audio, and fabricated AI success states.

## 3. Issues found and resolved (all verified by execution)

### P0 — Critical
| Issue | Evidence (baseline) | Fix | Verified by |
|---|---|---|---|
| Identity taken from client header `x-user-id`; `admin` value bypassed every ownership check | `curl -H 'x-user-id: admin'` read and **deleted** another user's project | Server-verified Firebase RS256 ID tokens + HMAC guest tokens; admins only via `ADMIN_USER_IDS` | `api.test.ts` "authentication", "projects isolation" |
| Path traversal in `/api/render/download/:id` | `..%2F..%2Fleak` served a file outside `data/` (200) | Strict `render_<32hex>` id; ids are now 128-bit random | `security.test.ts`, `api.test.ts` |
| Anonymous/default projects visible to and editable by everyone | Guest saw another user's test project and a 1.9 MB junk record in "My Projects" | Owner-only queries; sample project served read-only from code | E2E + integration |
| Free self-service upgrade to any plan (no payment) | `{"plan":"enterprise_unlimited"}` → 200 | 501 unless `BILLING_MODE=demo`; plan allowlist; subscriptions keyed by user, not IP | `api.test.ts` |
| Jobs readable/cancellable by anyone | `cancel` as another user → 200 | Owner checks (404) | `api.test.ts` |

### P1 — Broken core workflows / AI integrity
| Issue | Fix | Verified by |
|---|---|---|
| **Save silently failed (403) for every newly generated Short** (reused sample id; no UI error) | New id for new Shorts; sample is read-only; visible save errors | E2E |
| **Export truncated**: 33.0 s timeline → 10.58 s file, no audio | Real-time frame pacing, `captureStream(0)` + `requestFrame`, H.264 preference (VP8/VP9 dropped >80% of frames at 1080p), audio keep-alive | E2E asserts the duration matches within 1.5 s and an audio stream exists (measured: 27.0 s of 27.1 s) |
| "Transcribe clip" asked the LLM to transcribe audio it never received → fabricated captions presented as real | Removed. Real CC, or user text with **labelled estimated** timings, else 422 | `ai_workflow.test.ts` |
| AI failures served canned templates as AI output with hard-coded "96/100" scores | `isFallback`/`fallbackReason`/`fallbackMessage` on every AI endpoint; UI banner; no fabricated scores | `ai_workflow.test.ts`, E2E |
| Clip generation without a transcript invented timestamps/quotes, undisclosed | `grounded` + `groundingWarning`; captions always verbatim from transcript when available; deterministic transcript clips when the LLM is down | `ai_workflow.test.ts` |
| Free-text YouTube input turned any 11-letter word into a video id (`"productivity"` → `productivit`); hard-coded unverifiable fallback ids | Strict YouTube URL parsing; 400 with guidance | `youtube.test.ts`, E2E |
| Jobs: non-render jobs faked progress/success; cancel didn't stop ffmpeg; retry faked "completed" | Only real render jobs; queue with concurrency cap; SIGKILL on cancel; real retry; restart recovery | `api.test.ts` |
| LLM calls had no timeout; `jsonrepair` turned prose into "valid" output | Per-attempt `AbortSignal` timeout; object check; schema validation (`validateScript`) | unit tests |
| Rate limits bypassable via spoofed `X-Forwarded-For`; buckets shared across endpoints | `TRUST_PROXY` opt-in; per-route buckets; periodic sweep | `api.test.ts` |
| Malformed `Range` → 500; malformed JSON → HTML 500 | 416 / JSON 400; central error handler without stack traces | `api.test.ts` |
| Unbounded project payloads (1.9 MB stored), arbitrary fields incl. `userId` | Field allowlist, 512 KB, 200 projects/user | `api.test.ts` |
| Non-atomic JSON writes | temp + rename; corrupt files preserved | unit test |
| Sine-wave beep as the audio of server renders | Silent track (`anullsrc`) | `api.test.ts` |
| Server code never typechecked (8 errors) | `tsconfig.node.json` covers server; in `lint`/`build` | `npm run lint` |

### P2 / P3
* Dependency vulnerabilities: 11 → 3 (`bun audit fix`, incl. body-parser DoS); remaining are unreachable (documented).
* `@google/genai` was pinned to `"*"` → `^2.24.0`.
* `node_modules/`, `dist/`, `data/` were not gitignored; committed user/test data removed from git.
* Vite `allowedHosts: true` (dev DNS-rebinding exposure) removed.
* `PORT` env was ignored (hard-coded 3000) → honoured.
* Escape closes all modals; aria-labels on icon-only header buttons; mobile header no longer clipped.
* Landing-page fabricated metrics replaced with factual statements.
* Billing modal no longer invents usage ("14 render minutes used").
* Vendor chunk split (main bundle 653 KB → 451 KB).
* Graceful SIGTERM shutdown; `/api/ready` probe; structured JSON request/LLM logs with request ids.

## 4. Remaining issues

| Sev | Issue |
|---|---|
| **P1** | Real Gemini behaviour (model ids `gemini-3.1-flash-lite`, `gemini-3.8-flash`, `gemini-3.8-flash-lite-tts`, output quality, latency, cost) is **unverified** — run `GEMINI_API_KEY=… npm run test:live` |
| **P1** | Exports of YouTube-sourced clips cannot contain the original footage/audio (iframe capture is impossible; downloading conflicts with YouTube ToS). Disclosed in UI; needs a product decision |
| **P1** | Single-process JSON storage + in-memory limiter/queue: no horizontal scaling, no backups/PITR |
| **P1** | No payment integration (billing intentionally disabled) |
| P2 | No Content-Security-Policy |
| P2 | Guest sessions can be minted freely (bounded by per-IP limits/caps); add App Check/CAPTCHA |
| P2 | No log shipping/alerting/uptime monitoring wired up |
| P2 | Client export takes ~1× video duration and needs the tab in the foreground; measured effective 18.6 fps at 1080p in headless sandbox (target 30) |
| P2 | Google Drive export and real Firebase sign-in untested |
| P3 | Large `server.ts`/`App.tsx`; dead `YouTubeToClips.tsx`; mobile stepper hidden below `lg` |

Breakdown of remaining: **P0: 0 · P1: 4 · P2: 5 · P3: 3** (details in `docs/TECHNICAL_DEBT.md`).

## 5. Security assessment
* AuthN: Firebase ID tokens verified server-side (signature, aud, iss, exp, iat); guest tokens HMAC-signed with timing-safe compare; production refuses to start without `SESSION_SECRET` (verified, exit 1).
* AuthZ: every resource owner-checked; 404 on foreign ids (no enumeration).
* Injection: ffmpeg spawned with argument arrays (no shell); drawtext text stripped of quote/escape/`%`/`:`; user text delimited in prompts; strict id formats.
* SSRF: caption URLs from YouTube responses pass an allowlist + private-range/IPv6/decimal-IP blocklist.
* Secrets: keys only read from env; `/api/config` exposes presence booleans only; `.dev.env.json` ignored in production. The Firebase web config in the repo is a public client identifier, not a secret.
* CORS: same-origin in production unless `ALLOWED_ORIGINS` is set (preflight from a foreign origin returns no ACAO — verified).
* Container: non-root user, tini, healthcheck — image built and smoke-tested in CI. Compose read-only root FS + tmpfs + resource limits not yet exercised.
* "AI-generated code execution" isolation: **N/A** — the product executes no generated code. The only subprocess is ffmpeg with sanitized parameters, a 120 s kill timeout and a concurrency cap.

## 6. Performance (measured, `npm run test:load`, 20 concurrent clients, sandbox)
| Endpoint | p50 | p95 | p99 | Throughput |
|---|---:|---:|---:|---:|
| GET /api/health | 12.1 ms | 23.8 ms | 28.2 ms | 1526 rps |
| POST /api/projects (save) | 27.8 ms | 54.6 ms | 59.3 ms | 521 rps |
| GET /api/projects | 20.0 ms | 34.9 ms | 43.7 ms | 927 rps |
| POST /api/generate-script (fallback path) | 15.4 ms | 22.5 ms | 22.5 ms | – |
| Server render 15 s @1080p | 2.3 s wall | | | |
| Server RSS under test | 98 → 127 MB | | | |
| Landing page load (dev server, headless) | 4.9 s baseline | | | |
| Browser export 27.1 s Short @1080p | 28.0 s wall | | | |

The store is tiny in these runs; JSON-file latency grows linearly with total data. LLM latency could not be measured.

## 7. Test coverage (executed)
| Suite | Type | Result |
|---|---|---|
| `tests/security.test.ts` | unit (real modules) | 6/6 pass |
| `tests/youtube.test.ts` | unit | 7/7 pass |
| `tests/auth_llm_storage.test.ts` | unit (RS256/HMAC, LLM validation, atomic storage) | 6/6 pass |
| `tests/pipeline.test.ts` | unit (client timing pipeline) | 8/8 pass |
| `tests/api.test.ts` | integration: real server, HTTP, ffmpeg, files | 17/17 pass |
| `tests/ai_workflow.test.ts` | integration, **no LLM key, no mocks** (fallback path) | 11/11 pass |
| `tests/llm.live.test.ts` | **live provider** | 2 **skipped** (no key) |
| `tests/e2e/browser.e2e.test.ts` | Playwright on production build | 1/1 pass |
| `scripts/loadtest.ts` | load | executed, numbers above |

`npm test`: **57 tests, 55 pass, 0 fail, 2 skipped**. The previous suite (22 tests) tested copies of server functions and required a manually started server; it was replaced.

## 8. Deployment readiness
Ready: Dockerfile (multi-stage, non-root, healthcheck on `/api/ready`), compose, CI (lint → tests → build → E2E → audit gate → docker smoke), `.env.example`, fail-fast config, graceful shutdown, restart-safe jobs.
Verified on GitHub: CI pipeline and Docker image build + smoke test pass. Not ready: no deploy pipeline or image registry push, compose hardening untested, no backup job, no monitoring/alerting, no rollback procedure beyond redeploying the previous image tag.

## 9. Release blockers (must clear before launch)
1. Run `npm run test:live` with the production Gemini key; confirm model ids, output quality, latency and cost.
2. Decide the YouTube-source export story (or reposition the product copy).
3. Replace JSON storage with a managed DB, or explicitly accept single-instance operation with volume snapshots.
4. Wire log shipping and alerting on `/api/ready` and error rate; add a deploy/rollback pipeline (CI and Docker build are already green).
5. Integrate payments or remove paid-plan UI.
6. Verify Firebase sign-in and Drive export against the real project (authorized domains, App Check).

## 10. Change record
See the commit history on this branch. Files: `server.ts` (rewritten core), `server/lib/*` (new, tested), `src/utils/api.ts`,
`src/utils/useEscapeKey.ts` (new), `src/App.tsx`, `src/components/{AuthPage,ShortsPlayer,MyProjectsModal,BillingModal,ScriptEditor,VoiceToTextPanel,HomePage,StudioPage1Source,StudioPage2ClipStrategies,PublishingPackModal,GoogleDriveExportModal,StockPickerModal,YouTubeMetadataCard,YouTubeToClips}.tsx`,
`src/utils/{audio,voiceRecognition}.ts`, `src/types.ts`, tests, `scripts/loadtest.ts`, `Dockerfile`, `docker-compose.yml`,
`.github/workflows/ci.yml`, `.env.example`, `.gitignore`, `.dockerignore`, `package.json`, `bun.lock`, `tsconfig.node.json`, `vite.config.ts`, `README.md`, `docs/*`.
