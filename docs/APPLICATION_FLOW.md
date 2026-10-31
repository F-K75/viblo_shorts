# Application Flow

## 1. Onboarding
1. Landing (`HomePage`) → **Get Started** → `AuthPage`.
2. Sign in with Firebase (email/Google) **or** "Explore as Guest" → `POST /api/auth/guest` returns a signed token
   (stored in `localStorage.forge_guest_token`).
3. Every API call goes through `apiFetch` which attaches `Authorization: Bearer <token>`
   (Firebase ID token preferred, auto-refreshed). On 401 for guests, a new guest session is minted once.
4. Current page is kept in `sessionStorage` so a refresh keeps the user in the studio.

## 2. Studio step 1 — Source
* **Idea prompt:** `POST /api/generate-script` → validated script (`source: gemini`) or labelled template
  (`isFallback: true`, banner shown) → word timings estimated client-side → `POST /api/stock-footage` per beat.
* **YouTube link:** `POST /api/youtube/info` (rejects non-YouTube input with guidance) →
  `POST /api/youtube/generate-clips` (captions: pasted transcript → YouTube CC → none).
  Captions are taken verbatim from the transcript; when no transcript exists the response carries
  `grounded: false` + `groundingWarning`, shown in the UI.

## 3. Studio step 2 — Clip strategies & trimmer
Pick a candidate, adjust in/out points, framing (fill/fit) and audio volume. Scores are shown only when the model
returned one ("Unscored" otherwise — no fabricated numbers).

## 4. Studio step 3 — Canvas & timeline
Edit beats/timings, caption style, voice (Gemini TTS via `/api/tts`, else browser speech), music, B-roll.
* **Save:** `POST /api/projects` (new id for new Shorts; the sample project is read-only → saved as new).
* **Export:** client canvas render at real-time pace, H.264 preferred, audio graph kept alive; download.
* **Publishing pack:** `POST /api/publish/generate-pack` → titles/hashtags + SRT/VTT.
* **Drive:** client-side OAuth upload (not tested here).

## 5. Background rendering (API)
`POST /api/jobs/create {type: render_video}` → queued (max `MAX_CONCURRENT_RENDERS`) → ffmpeg →
`GET /api/jobs/:id` → `/api/render/download/:renderId` (capability URL, Range support). Cancel kills ffmpeg;
retry re-renders; jobs interrupted by a restart are marked failed on boot. Artifacts expire after `RENDER_TTL_HOURS`.

## Failure behaviour (verified)
| Failure | Behaviour |
|---|---|
| No / invalid Gemini key, model 5xx, timeout | Bounded retries (≤2 per model), then labelled template; banner in UI; metrics in `/api/health` |
| Invalid model JSON / schema | Rejected by `validateScript` / object check → fallback, never passed to client raw |
| Network down (YouTube/Pexels) | Timeouts (4–8 s) → defaults / curated library |
| Bad input | 400 with message; malformed JSON 400; oversized 413 |
| Rate/quota exceeded | 429 with `Retry-After` |
| Save/export failure | Visible error banner (previously silent) |
| Server restart mid-render | Job marked failed with reason; retry available |
| Storage corruption | Corrupt file preserved as `*.corrupt-<ts>`; fallback to empty |
