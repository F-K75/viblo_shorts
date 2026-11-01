// Pure security / validation helpers. Imported by server.ts AND by the test-suite,
// so tests exercise the exact production code (no mirrored copies).

export function sanitizeString(input: unknown, maxLength = 500): string {
  if (typeof input !== 'string') return '';
  return input
    .slice(0, maxLength)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g, '')
    .trim();
}

export function isValidYouTubeId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

/** Render ids are server generated: `render_<32 hex>`. Anything else is rejected (prevents path traversal). */
export function isValidRenderId(id: unknown): id is string {
  return typeof id === 'string' && /^render_[a-f0-9]{32}$/.test(id);
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

// Strict SSRF and safe URL validation (hostname level; callers additionally pass an allowlist).
export function isSafeExternalUrl(urlStr: string, allowedHostSuffixes?: string[]): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.includes(':') || // any literal IPv6 address
      isPrivateIPv4(hostname) ||
      /^\d+$/.test(hostname) // decimal-encoded IPs, e.g. http://2130706433
    ) {
      return false;
    }

    if (allowedHostSuffixes && allowedHostSuffixes.length > 0) {
      return allowedHostSuffixes.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    }
    return true;
  } catch {
    return false;
  }
}

export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null;

/** Parses a single-range `bytes=` header. Returns null when absent/ignorable, 'unsatisfiable' for 416. */
export function parseRangeHeader(header: string | undefined, fileSize: number): RangeResult {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'unsatisfiable';
  const [, s, e] = m;
  if (s === '' && e === '') return 'unsatisfiable';
  let start: number;
  let end: number;
  if (s === '') {
    // suffix range: last N bytes
    const n = Number(e);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, fileSize - n);
    end = fileSize - 1;
  } else {
    start = Number(s);
    end = e === '' ? fileSize - 1 : Math.min(Number(e), fileSize - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
    return 'unsatisfiable';
  }
  return { start, end };
}

/** Escapes free text for an FFmpeg drawtext `text='...'` value (removes quote/escape chars and % expansions). */
export function escapeDrawtext(text: string, maxLen = 100): string {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/['"\\:%;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
