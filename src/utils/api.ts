// Authenticated API client. Every /api request carries a bearer token that the server verifies:
//  - a Firebase ID token when the user is signed in with Firebase (auto-refreshed by the SDK), or
//  - a server-signed guest token (obtained from /api/auth/guest and kept in localStorage).
// The server never trusts a client-supplied user id.
import { auth } from './googleDrive';
import { captchaConfig, getCaptchaToken, guestMintErrorMessage } from './captcha';

const GUEST_TOKEN_KEY = 'forge_guest_token';
let guestTokenPromise: Promise<string> | null = null;

function readGuestToken(): string | null {
  try {
    const raw = localStorage.getItem(GUEST_TOKEN_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (typeof token === 'string' && new Date(expiresAt).getTime() > Date.now() + 60_000) return token;
  } catch {
    // ignore corrupt storage
  }
  return null;
}

/** Creates (or reuses) a guest session. Returns the guest user id issued by the server. */
export async function ensureGuestSession(): Promise<{ token: string; userId: string }> {
  const existing = readGuestToken();
  if (existing) {
    try {
      const payload = JSON.parse(atob(existing.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return { token: existing, userId: payload.sub };
    } catch {
      // fall through and mint a new one
    }
  }
  // Track A: solve Turnstile first when the server requires it (the token is single-use and verified server-side).
  const captcha = await captchaConfig();
  const body = captcha ? JSON.stringify({ 'cf-turnstile-response': await getCaptchaToken(captcha.siteKey) }) : undefined;
  const res = await fetch('/api/auth/guest', { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body });
  if (!res.ok) {
    const code = await res
      .json()
      .then((j) => j?.code as string | undefined)
      .catch(() => undefined);
    throw new Error(guestMintErrorMessage(res.status, code));
  }
  const data = await res.json();
  localStorage.setItem(GUEST_TOKEN_KEY, JSON.stringify({ token: data.token, expiresAt: data.expiresAt }));
  return { token: data.token, userId: data.userId };
}

export function clearGuestSession() {
  localStorage.removeItem(GUEST_TOKEN_KEY);
}

async function getAuthToken(): Promise<string> {
  try {
    await auth.authStateReady();
    if (auth.currentUser) return await auth.currentUser.getIdToken();
  } catch {
    // Firebase unavailable (offline / blocked): fall back to guest session
  }
  if (!guestTokenPromise) {
    guestTokenPromise = ensureGuestSession()
      .then((s) => s.token)
      .finally(() => {
        guestTokenPromise = null;
      });
  }
  return guestTokenPromise;
}

/** fetch() wrapper for same-origin /api calls that attaches the bearer token and retries once on 401. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await getAuthToken()}`);
    return fetch(input, { ...init, headers });
  };
  let res = await send();
  if (res.status === 401 && !auth.currentUser) {
    // Guest token expired or server secret rotated: mint a fresh guest session once.
    clearGuestSession();
    res = await send();
  }
  return res;
}

/** Extracts a user-presentable error message from a failed API response. */
export async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.error === 'string') return data.error;
  } catch {
    // non-JSON
  }
  if (res.status === 429) return 'You are sending requests too quickly. Please wait a moment.';
  if (res.status >= 500) return `${fallback} (server error ${res.status}). Please try again.`;
  return fallback;
}
