# Frontend Health & Architecture Audit

**File:** `engineering/FRONTEND_AUDIT.md`  
**Scope:** `src/`, `index.html`, `vite.config.ts`, `package.json`  
**Reference Codebase Commit:** `dffa550` (main branch)

---

## 1. Executive Summary

Forge Studio's frontend is a Single Page Application (SPA) built with **React 19**, **Vite 6**, and **Tailwind CSS 4**. It provides an interactive, client-driven workspace for creating, editing, and rendering 9:16 vertical shorts. Rather than relying on an external routing library (such as `react-router`), application view states (`home`, `auth`, `studio-step1`, `studio-step2`, `studio-step3`) are managed in top-level state within `src/App.tsx`.

### Top Findings & Observations
1. **[Medium] State Concentration in App.tsx:** `src/App.tsx` is ~47KB and coordinates page navigation, modal toggles, project lifecycle, and export queues. While functional, breaking this into dedicated context providers (e.g. `ProjectContext`, `AuthContext`) would improve maintainability.
2. **[Pass] Client-Side Render Performance:** `ShortsPlayer.tsx` and `audio.ts` render dynamic subtitles and audio waveforms with standard HTML5 Canvas 2D and Web Audio API, minimizing latency and eliminating server render bottlenecks.
3. **[Pass] Secure Token Attachment:** `src/utils/api.ts` transparently manages Firebase ID tokens and guest session tokens, automatically injecting `Authorization: Bearer <token>` onto all backend requests.
4. **[Pass] Modal Keyboard Accessibility:** Modal components implement escape-key listeners (`src/utils/useEscapeKey.ts`) and focus traps.
5. **[Low] Direct Global CSS:** `src/index.css` is compact and imports Tailwind directives cleanly.

---

## 2. Component Structure & Architecture

```
src/
├── App.tsx                        # Master application state, view router, and top navigation
├── components/
│   ├── AuthPage.tsx               # Firebase Auth (email/password & Google popup) + guest login
│   ├── BillingModal.tsx           # Subscription tiers and Stripe billing modal
│   ├── CaptionStyleConfig.tsx     # Typography, stroke, shadow, highlight customization
│   ├── GoogleDriveExportModal.tsx # Client-side direct upload to Google Drive
│   ├── HomePage.tsx               # Project grid, quick-start templates, and usage quota
│   ├── MyProjectsModal.tsx        # Saved projects drawer with search & deletion
│   ├── PublishingPackModal.tsx    # Title, description, tags, and thumbnail generator
│   ├── ScriptEditor.tsx           # Multi-scene script and voice prompt editor
│   ├── ShortsPlayer.tsx           # 9:16 video canvas preview with synchronized captions
│   ├── StockPickerModal.tsx       # Pexels stock video / audio selection modal
│   ├── StudioPage1Source.tsx      # Step 1: Input selection (prompt, script, YouTube URL)
│   ├── StudioPage2ClipStrategies.tsx # Step 2: Hook, body, CTA breakdown & timing
│   ├── StudioPage3CanvasTimeline.tsx # Step 3: Scene timeline and visual layer sequencing
│   ├── VoiceToTextPanel.tsx       # Voice input / recording integration
│   ├── YouTubeClipTrimmer.tsx     # Video segment selector for YouTube sources
│   ├── YouTubeMetadataCard.tsx    # YouTube video details and thumbnail preview
│   └── YouTubeToClips.tsx         # Automated caption to clips conversion wizard
├── utils/
│   ├── api.ts                     # Fetch wrapper with auto-auth and error normalization
│   ├── audio.ts                   # Web Audio synth, TTS playback, and waveform analyzers
│   ├── captcha.ts                 # Cloudflare Turnstile token retrieval helper
│   ├── googleDrive.ts             # Google Picker and Drive v3 upload helpers
│   ├── pipeline.ts                # Step transitions and project serialization
│   ├── useEscapeKey.ts            # Accessibility hook for dialogs
│   ├── visualPlaceholders.ts      # Canvas visual generator for fallback backgrounds
│   └── voiceRecognition.ts        # Browser SpeechRecognition API wrapper
├── types.ts                       # Shared frontend TypeScript interfaces
└── main.tsx                       # React DOM root bootstrapping
```

---

## 3. Client State Management & Data Flow

* **Page & Workflow State:** Managed via `useState` hooks in `App.tsx`:
  * `currentPage`: `'home' | 'auth' | 'studio-1' | 'studio-2' | 'studio-3'`
  * `activeProject`: Complete project payload (scenes, caption style, audio settings).
* **Persistence Synchronization:** When a user alters scenes or settings, updates are sent to `/api/projects/:id` via `src/utils/api.ts` with debouncing.
* **Media Handling:** Media playback utilizes standard HTML5 `<video>` elements with canvas overlays to preview synchronized subtitles without round-tripping to the server.

---

## 4. Accessibility & UI Quality

| Area | Evaluation | Status |
|---|---|---|
| **Keyboard Navigation** | Modals listen for `Escape` (`useEscapeKey.ts`). Inputs utilize standard HTML form tags. | **Pass** |
| **Color Contrast** | Dark theme (`#0f172a` slate backgrounds with high-contrast text and buttons) conforms to WCAG AA. | **Pass** |
| **Responsive Design** | Flex and grid layouts adapt from mobile viewports to desktop desktop monitors. | **Pass** |
| **Bundle Footprint** | Built with Vite 6; code-splitting configured for major vendor libraries. | **Pass** |

---

## 5. Recommendations

1. **Context Extraction:** Split `App.tsx` state into React Contexts (`AuthContext`, `StudioContext`) to prevent unnecessary re-renders across the component tree.
2. **Error Boundary Integration:** Wrap `ShortsPlayer` and `ScriptEditor` in an `ErrorBoundary` to gracefully recover from canvas or audio decode errors without tearing down the entire application state.
3. **Lazy-Load Modals:** Utilize `React.lazy()` for heavy modals such as `GoogleDriveExportModal` and `PublishingPackModal` to reduce initial bundle size.

