# Technical Debt Register

| # | Item | Severity | Notes / suggested fix |
|---|---|---|---|
| 1 | JSON-file persistence, in-memory limiter/queue | P1 (scalability) | Blocks horizontal scaling. Move to Postgres + Redis + object storage |
| 2 | `server.ts` is still ~2.3k lines | P3 | Pure logic extracted to `server/lib/*` (tested). Next: split routes into routers |
| 3 | `App.tsx` (~1.2k lines) owns all state; no router | P3 | Introduce a router + state store; deep links per step |
| 4 | Client export is real-time canvas recording | P2 | Slow (≈1× duration), depends on browser codecs and foreground tab. Server-side compositing (ffmpeg with footage + TTS) would be robust |
| 5 | YouTube-sourced clips cannot be exported with original video/audio | P1 (product) | Browser cannot capture the iframe; downloading YouTube media conflicts with YouTube ToS. Currently disclosed in UI; needs a product decision (creator-uploaded source files) |
| 6 | Server render is caption-only | P2 | Does not composite footage/narration; documented |
| 7 | Gemini model ids not verifiable here | P1 | `GEMINI_MODELS` env; run `npm run test:live` with a real key before launch |
| 8 | No CSP header | P2 | Needs allowlist for Firebase, Google Fonts, YouTube embeds, Unsplash/Mixkit/Pexels media, Drive API |
| 9 | Hard-coded fallback media URLs (Mixkit/Unsplash) | P3 | Some entries have empty `url`; licensing should be re-verified |
| 10 | `src/components/YouTubeToClips.tsx` is unused | P3 | Dead code; delete or wire up |
| 11 | Firebase web config committed | Info | Web API keys are public identifiers by design; restrict via Firebase App Check / authorized domains |
| 12 | Guest tokens can be minted freely (10/min/IP) | P2 | Abuse bounded by per-IP rate + per-IP daily AI cap; consider CAPTCHA/App Check |
| 13 | Render download is a capability URL (no auth header) | P3 | 128-bit random id + 24 h TTL; acceptable, documented |
| 14 | Legacy README pipeline (Python) does not exist | Fixed | README rewritten |
| 15 | Remaining audit advisories | P3 | vite dev-server only; grpc-js via unused firestore (ignored in CI with justification) |
| 16 | Main JS chunk 451 KB (123 KB gz) | P3 | Lazy-load studio vs landing; code-split modals |
| 17 | No observability backend | P2 | Structured JSON logs + `/api/health` metrics exist; needs log shipping, alerting, uptime checks |
| 18 | Mobile: step navigator hidden below `lg` | P3 | In-page Back/Continue buttons exist; add compact mobile stepper |
