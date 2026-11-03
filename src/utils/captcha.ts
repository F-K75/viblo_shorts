// Track A (R-03): Cloudflare Turnstile before the first guest session. The server publishes the public site key in
// /api/config (features.captcha); the secret never reaches the browser. The token is single-use and is sent once,
// in the guest-mint request, where the server verifies it with Cloudflare.
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__onTurnstileLoad';
const ACTION = 'guest_mint';

interface CaptchaConfig {
  provider: 'turnstile';
  siteKey: string;
}

let configPromise: Promise<CaptchaConfig | null> | null = null;
let scriptPromise: Promise<any> | null = null;

/** The server's CAPTCHA requirement (null when guest sign-up needs no CAPTCHA). */
export function captchaConfig(): Promise<CaptchaConfig | null> {
  if (!configPromise) {
    configPromise = fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => (c?.features?.captcha?.provider === 'turnstile' && c.features.captcha.siteKey ? (c.features.captcha as CaptchaConfig) : null))
      .catch(() => {
        configPromise = null; // retry next time
        return null;
      });
  }
  return configPromise;
}

function loadTurnstile(): Promise<any> {
  const w = window as any;
  if (w.turnstile) return Promise.resolve(w.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        scriptPromise = null;
        reject(new Error('The verification service could not be loaded. Check your connection, or sign in to continue.'));
      }, 15000);
      w.__onTurnstileLoad = () => {
        clearTimeout(timer);
        resolve(w.turnstile);
      };
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onerror = () => {
        clearTimeout(timer);
        scriptPromise = null;
        reject(new Error('The verification service could not be loaded. Check your connection, or sign in to continue.'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Runs the Turnstile challenge and resolves with a fresh, single-use token. The widget is shown in a small overlay
 * only while it is needed (most visitors are verified without interaction).
 */
export async function getCaptchaToken(siteKey: string): Promise<string> {
  const turnstile = await loadTurnstile();
  const box = document.createElement('div');
  box.setAttribute('data-testid', 'captcha-box');
  box.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;';
  document.body.appendChild(box);
  try {
    return await new Promise<string>((resolve, reject) => {
      turnstile.render(box, {
        sitekey: siteKey,
        action: ACTION,
        callback: (token: string) => resolve(token),
        'error-callback': () => reject(new Error('Verification failed. Please try again.')),
        'expired-callback': () => reject(new Error('Verification expired. Please try again.')),
        'timeout-callback': () => reject(new Error('Verification timed out. Please try again.')),
      });
    });
  } finally {
    box.remove();
  }
}

/** A user-presentable message for a refused guest mint (codes from POST /api/auth/guest). */
export function guestMintErrorMessage(status: number, code: string | undefined): string {
  switch (code) {
    case 'captcha_unavailable':
      return 'Guest sign-up is temporarily unavailable (verification service down). Please try again shortly, or sign in to continue.';
    case 'captcha_required':
    case 'captcha_failed':
    case 'captcha_replayed':
      return 'Verification failed. Please try again.';
    case 'guest_rate_limited':
      return 'Too many guest sessions were started from your device or network recently. Please try again later, or sign in.';
    case 'guest_capacity':
      return 'Guest sign-ups are paused because of high demand. Please sign in (free) to continue.';
    default:
      return `Could not start a guest session (${status}). Please try again.`;
  }
}
