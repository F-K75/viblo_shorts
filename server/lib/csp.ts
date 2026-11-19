// Content-Security-Policy and related browser security headers (FS-013 / R-17).
// Pure functions: server.ts builds the policy once at startup from the environment; tests call the same code.
//
// The allow-list is derived from what the client actually loads. Every host carries the code reference that needs it,
// so a host can be removed when its feature goes away. Deployments that need more (a CDN, a custom Firebase auth
// domain, reCAPTCHA Enterprise enforcement on email sign-in, ...) add hosts with the CSP_EXTRA_* variables instead of
// editing this file.

export type CspFetchDirective = 'script-src' | 'style-src' | 'font-src' | 'img-src' | 'media-src' | 'connect-src' | 'frame-src';

export const CSP_EXTRA_ENV: Record<CspFetchDirective, string> = {
  'script-src': 'CSP_EXTRA_SCRIPT_SRC',
  'style-src': 'CSP_EXTRA_STYLE_SRC',
  'font-src': 'CSP_EXTRA_FONT_SRC',
  'img-src': 'CSP_EXTRA_IMG_SRC',
  'media-src': 'CSP_EXTRA_MEDIA_SRC',
  'connect-src': 'CSP_EXTRA_CONNECT_SRC',
  'frame-src': 'CSP_EXTRA_FRAME_SRC',
};

export interface CspOptions {
  /** 'production' is the strict policy (also used by test servers). 'development' relaxes it for the Vite dev server. */
  mode: 'production' | 'development';
  /** Firebase authDomain from firebase-applet-config.json: hosts the hidden auth iframe used by signInWithPopup. */
  firebaseAuthDomain?: string;
  /** Additional sources per directive (validated by parseCspEnv). */
  extra?: Partial<Record<CspFetchDirective, string[]>>;
  /** Adds report-uri. */
  reportUri?: string;
  /** Adds upgrade-insecure-requests (only for requests that arrived over HTTPS; ignored in report-only mode). */
  upgradeInsecureRequests?: boolean;
  /** Report-only policies cannot carry upgrade-insecure-requests (the browser ignores it and logs a warning). */
  reportOnly?: boolean;
}

/** Base allow-list. Comments name the code that needs each source. */
const BASE: Record<CspFetchDirective, string[]> = {
  'script-src': [
    "'self'", // Vite build: dist/assets/*.js (no inline scripts in dist/index.html)
    'https://challenges.cloudflare.com', // Turnstile widget script, src/utils/captcha.ts (SCRIPT_URL)
    'https://apis.google.com', // gapi loader injected by firebase/auth for signInWithPopup (AuthPage.tsx, utils/googleDrive.ts)
  ],
  'style-src': [
    "'self'", // dist/assets/*.css (Tailwind)
    // 'unsafe-inline': React `style={...}` props are applied through the CSSOM and need nothing, but third-party
    // widgets we cannot exercise here (Turnstile api.js, Google's gapi/iframes loader) build styled DOM in our
    // document, and the Vite dev server injects <style> tags. Style injection cannot run script; the script policy
    // stays strict. Revisit with 'unsafe-hashes' once those widgets are verified in production report-only mode.
    "'unsafe-inline'",
    'https://fonts.googleapis.com', // Google Fonts stylesheet, index.html
  ],
  'font-src': [
    "'self'",
    'https://fonts.gstatic.com', // font files referenced by the Google Fonts stylesheet, index.html
  ],
  'img-src': [
    "'self'",
    'data:', // SVG placeholders (src/utils/visualPlaceholders.ts) and the favicon (index.html)
    'blob:', // local object URLs (previews of locally attached / exported media)
    'https://i.ytimg.com', // YouTube thumbnails: ShortsPlayer.tsx, HomePage.tsx, App.tsx; server.ts oEmbed thumbnailUrl
    'https://images.pexels.com', // Pexels stock thumbnails (server.ts /api/stock-footage `v.image`)
    'https://images.unsplash.com', // curated stock thumbnails (server.ts FALLBACK_VERTICAL_VIDEOS, MyProjectsModal.tsx)
    'https://lh3.googleusercontent.com', // Google account photoURL (App.tsx, AuthPage.tsx, GoogleDriveExportModal.tsx)
    'https://api.dicebear.com', // default avatars (App.tsx, AuthPage.tsx)
  ],
  'media-src': [
    "'self'", // same-origin video downloads (/api/...)
    'blob:', // object URLs: local source videos, TTS WAV (src/utils/audio.ts), exported shorts
    'https://assets.mixkit.co', // curated stock clips (src/utils/visualPlaceholders.ts FALLBACK_VIDEOS, server.ts)
    'https://videos.pexels.com', // Pexels stock video files (server.ts /api/stock-footage `video_files[].link`)
  ],
  'connect-src': [
    "'self'", // /api/* (src/utils/api.ts)
    'https://identitytoolkit.googleapis.com', // Firebase Auth sign-in / sign-up / password reset (AuthPage.tsx)
    'https://securetoken.googleapis.com', // Firebase Auth ID-token refresh
    'https://www.googleapis.com', // Google Drive v3 + upload API (src/utils/googleDrive.ts)
  ],
  'frame-src': [
    'https://www.youtube.com', // YouTube player embed (ShortsPlayer.tsx /embed/<id>, controlled with postMessage)
    'https://challenges.cloudflare.com', // Turnstile challenge iframe (src/utils/captcha.ts)
    // + https://<firebase authDomain>: firebase/auth hidden iframe (/__/auth/iframe) for signInWithPopup
  ],
};

const ORDER: CspFetchDirective[] = ['script-src', 'style-src', 'font-src', 'img-src', 'media-src', 'connect-src', 'frame-src'];

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** Builds the Content-Security-Policy header value. */
export function buildContentSecurityPolicy(opts: CspOptions): string {
  const dev = opts.mode === 'development';
  const sources = Object.fromEntries(ORDER.map((d) => [d, [...BASE[d], ...(opts.extra?.[d] || [])]])) as Record<CspFetchDirective, string[]>;
  if (opts.firebaseAuthDomain) sources['frame-src'].push(`https://${opts.firebaseAuthDomain}`);
  if (dev) {
    // Vite dev server only: the React Refresh preamble is an inline module script, and HMR uses a websocket.
    sources['script-src'].push("'unsafe-inline'");
    sources['connect-src'].push('ws:', 'wss:');
  }
  const directives = [
    "default-src 'self'",
    ...ORDER.map((d) => `${d} ${unique(sources[d]).join(' ')}`),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ];
  if (opts.upgradeInsecureRequests && !opts.reportOnly) directives.push('upgrade-insecure-requests');
  if (opts.reportUri) directives.push(`report-uri ${opts.reportUri}`);
  return directives.join('; ');
}

export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

// A source added through the environment: an https/wss origin (optionally *.wildcard subdomain, port and path), or
// the blob:/data: schemes. Keywords ('unsafe-eval', 'unsafe-inline', nonces...) and bare wildcards are refused so the
// environment cannot weaken the script policy by accident.
const EXTRA_SOURCE = /^(?:(?:https|wss):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?(?:\/[A-Za-z0-9._~\-\/]*)?|blob:|data:)$/i;

export type CspEnvResult =
  | { ok: true; extra: Partial<Record<CspFetchDirective, string[]>>; reportOnly: boolean; reportUri?: string }
  | { ok: false; error: string };

/** Reads CSP_EXTRA_*, CSP_REPORT_ONLY and CSP_REPORT_URI. Invalid values are an error (the server refuses to start). */
export function parseCspEnv(env: Record<string, string | undefined>): CspEnvResult {
  const extra: Partial<Record<CspFetchDirective, string[]>> = {};
  for (const d of ORDER) {
    const name = CSP_EXTRA_ENV[d];
    const list = (env[name] || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of list) {
      if (!EXTRA_SOURCE.test(s)) {
        return { ok: false, error: `${name}: "${s.slice(0, 100)}" is not an https:// or wss:// source (or blob:/data:). CSP keywords are not accepted.` };
      }
    }
    if (list.length) extra[d] = list;
  }
  const ro = (env.CSP_REPORT_ONLY || '').trim().toLowerCase();
  if (ro && !['true', 'false', '1', '0'].includes(ro)) return { ok: false, error: 'CSP_REPORT_ONLY must be true or false.' };
  const reportUri = (env.CSP_REPORT_URI || '').trim() || undefined;
  if (reportUri && !/^(?:https:\/\/[^\s;,'"]+|\/[^\s;,'"]*)$/.test(reportUri)) {
    return { ok: false, error: 'CSP_REPORT_URI must be an https:// URL or a same-origin path starting with "/".' };
  }
  return { ok: true, extra, reportOnly: ro === 'true' || ro === '1', reportUri };
}

/**
 * Permissions-Policy: microphone for voice dictation (src/utils/voiceRecognition.ts); camera, geolocation, payment
 * and USB are never used. Autoplay, encrypted-media, fullscreen and picture-in-picture keep their browser defaults
 * ('self'), which the YouTube iframe receives through its `allow` attribute (ShortsPlayer.tsx).
 */
export const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(self), payment=(), usb=()';

/**
 * Cross-Origin-Opener-Policy: isolates the window from cross-origin openers while keeping the opener link to popups
 * we open, which Firebase signInWithPopup (Google sign-in and the Drive export sign-in) needs. 'same-origin' would
 * break those popups.
 */
export const CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups';
