# Feature Inventory (verified status)

Legend: ✅ works end-to-end (executed) · ⚠️ works with documented limits · ❌ broken/not implemented ·
🔒 untestable in this environment (credential/network) · N/A not part of this product.

| Feature | Before audit | After | Evidence |
|---|---|---|---|
| Landing page | ⚠️ fabricated stats ("140,000+ shorts", "+240% retention", "0.05s precision") | ✅ factual claims | Browser walkthrough |
| Sign-up / sign-in (Firebase email, Google) | 🔒 client-only; server ignored identity | 🔒 server verifies Firebase ID tokens (unit + integration tested with test keys) | Firebase endpoints unreachable from sandbox |
| Guest onboarding | ⚠️ client invented `guest_<timestamp>` id | ✅ server-signed guest session | E2E test |
| Session persistence on refresh | ⚠️ token-less; reload landed on marketing page | ✅ stays in studio | E2E test |
| Idea → script generation | ⚠️ silent template when AI down, shown with fake "96/100" score | ✅ AI path validated; fallback explicitly labelled | Integration tests; 🔒 live Gemini untested (no key) |
| YouTube link → clip strategies | ❌ free-text topics became bogus video ids; clips invented without transcript, undisclosed | ⚠️ link validation; transcript-grounded verbatim captions; ungrounded results carry a warning | Integration tests; 🔒 YouTube unreachable |
| Paste transcript → captions | ✅ | ✅ | Unit + integration |
| "Hear video" voice transcription | ❌ LLM asked to "transcribe" audio it never received (fabricated captions) | ✅ only real CC or user text with **estimated** timings, labelled | Integration test |
| Beat rewrite / hook suggestions / metadata | ⚠️ silent no-op / templates when AI down | ✅ flagged; UI tells user | Integration tests |
| Stock footage search | ⚠️ | ⚠️ curated library fallback; Pexels 🔒 | Integration test |
| Timeline editing, caption styles | ✅ | ✅ | Browser walkthrough |
| Save project | ❌ new shorts reused sample id → silent 403 | ✅ | E2E test |
| My Projects (list/open/duplicate/delete) | ❌ showed other users' data; no Esc | ✅ isolated; Esc closes | E2E + integration |
| Browser export (MP4/WebM) | ❌ 33 s timeline exported as 10.6 s, no audio | ✅ duration matches timeline, audio track present | E2E asserts with ffprobe |
| Export of YouTube-sourced clips | ❌ silently exported thumbnail only | ✅ with user-uploaded source video (real footage + original audio, cut to clip); otherwise labelled captions-only | E2E (ffprobe: duration, frame content, audio level) |
| Caption sync with YouTube audio | ❌ independent timer; handshake never completed, so captions ran ahead while the video buffered | ✅ official IFrame API; player is the master clock, captions hold while buffering | E2E with API stand-in (YouTube unreachable here) |
| Server FFmpeg render + jobs | ⚠️ fake jobs; cancel didn't stop; retry faked success | ✅ real queue, kill on cancel, real retry | Integration tests |
| Publishing pack (SRT/VTT, platform copy) | ✅ | ✅ | Integration test |
| Google Drive export | 🔒 | 🔒 untested (OAuth + network) | — |
| Billing / plans | ❌ anyone could self-grant any plan for free | ⚠️ disabled (501) until a payment provider exists; `BILLING_MODE=demo` for demos | Integration test |
| Usage quotas | ⚠️ per-IP, spoofable | ✅ per-user plan quota + per-IP cap | Integration test |
| Workspaces, code generation, agents, builds, teams, chat, notifications | N/A | N/A | Not present in codebase |
