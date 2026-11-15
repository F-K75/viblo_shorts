# Security & Vulnerability Audit

**File:** `engineering/SECURITY_AUDIT.md`  
**Scope:** `server/lib/security.ts`, `server/lib/auth.ts`, `server.ts`, `.env.example`, dependency auditing  
**Reference Codebase Commit:** `dffa550` (main branch)

---

## 1. Executive Summary

The Forge Studio codebase exhibits rigorous, defense-in-depth security engineering. Key protections include strict cryptographic token verification with timing-attack prevention, canonical base64url encoding checks, comprehensive SSRF protection blocking all private IPv4/IPv6 ranges and decimal encodings, safe child-process spawning (avoiding shell execution), and multi-tenant resource scoping.

### Top Findings & Observations
1. **[Pass] Timing-Safe HMAC Verification:** `server/lib/auth.ts` line 57 uses `crypto.timingSafeEqual` to verify guest token signatures, eliminating side-channel timing attacks.
2. **[Pass] Anti-Malleability Canonical Checks:** `server/lib/auth.ts` line 27 enforces `isCanonicalB64url` on all token components, rejecting non-canonical encodings and padding variations.
3. **[Pass] Comprehensive SSRF Defense:** `server/lib/security.ts` line 38 checks URLs against RFC 1918, CGNAT (100.64.0.0/10), loopback, link-local (169.254.0.0/16), IPv6 literal addresses, and integer-encoded IPs before allowing outbound fetches.
4. **[Pass] Zero-Shell FFmpeg Invocation:** Media rendering invokes `child_process.spawn('ffmpeg', args)` with explicit string arguments; `escapeDrawtext` strips quotes, percent signs, and semicolons to block filter parameter injection.
5. **[Pass] Secret Discipline:** Production strictly enforces `SESSION_SECRET` length (>= 32 chars) at boot; `.env.example` contains placeholder tokens only with zero committed secrets.

---

## 2. Authentication & Authorization Analysis

### Token Verification
* **Firebase Auth:**
  * Uses Google's `securetoken@system.gserviceaccount.com` public certificates.
  * Validates token headers (`alg: "RS256"`, `kid`), issuer (`https://securetoken.google.com/<projectId>`), audience, and clock skew (60s margin).
* **Guest Sessions:**
  * Signed tokens format: `guest.<payload>.<HMAC-SHA256>`.
  * Subject format strictly enforced to `guest_[a-f0-9]{32}`.
  * Tokens expire after 30 days (`GUEST_TTL_SECONDS = 30 * 24 * 3600`).
* **Multi-Tenant Authorization:**
  * Queries in `server/db/pgRepo.ts` and `server/lib/jsonRepo.ts` universally constrain lookups by `user_id = $1`. Cross-user access returns an opaque `404 Not Found` to prevent account enumeration.

---

## 3. Network & Request Hardening

| Control | Implementation File | Verification Status |
|---|---|---|
| **Content Security Policy (CSP)** | `server.ts` | Sets strict `default-src 'self'`, script hashes, and media/connect source allowlists. |
| **HTTP Headers** | `server.ts` | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`. |
| **CORS Policy** | `server.ts` | Configured via `cors` middleware; origin restricted in production based on `ALLOWED_ORIGIN`. |
| **Body Size Limits** | `server.ts` | JSON parser clamped to 1MB (`express.json({ limit: '1mb' })`). |
| **HTTP Range Safety** | `server/lib/security.ts` | `parseRangeHeader` guards against unsatisfiable, malformed, or integer-overflow range attacks on media files. |

---

## 4. Input Sanitization & Command Injection

* **FFmpeg Drawtext Escaping:** Subtitle overlays are sanitized via `escapeDrawtext()` in `server/lib/security.ts`:
  ```typescript
  export function escapeDrawtext(text: string, maxLen = 100): string {
    return String(text || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/['"\\:%;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  ```
  This eliminates escape sequences and `%` parameter format strings before interpolation into filtergraphs.
* **Path Traversal Guard:** Render identifiers are strictly matched against `/^render_[a-f0-9]{32}$/` in `isValidRenderId()`, preventing relative path traversal (`../../`) when resolving files in `DATA_DIR/renders/`.

---

## 5. Dependency Audit & Secret Hygiene

* **Dependency Auditing:** CI executes `bun audit --audit-level=high --ignore GHSA-m9gg-hp2v-232j` (the ignored advisory pertains to `@grpc/grpc-js` via unused `firebase/firestore`, whereas Forge Studio only imports `firebase/app` and `firebase/auth`).
* **Secret Handling:** All secrets (`GEMINI_API_KEY`, `DATABASE_URL`, `SESSION_SECRET`, `S3_SECRET_KEY`) are read strictly from environment variables.

---

## 6. Recommendations

1. **Regular Dependency Scanning:** Automate weekly Dependabot or Snyk alerts for transitive dependencies.
2. **Rate Limit Persistence:** When running multi-instance clusters, back rate-limiting buckets with Redis or PostgreSQL rather than in-memory token buckets.
3. **Session Secret Rotation Plan:** Document a dual-key verification grace period to enable seamless zero-downtime rotation of `SESSION_SECRET`.

