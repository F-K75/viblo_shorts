# Phase 2.5 Track A: guest registration protection (R-03)

Status: **implemented on branch `claude/keen-feynman-xtbvz2-track-a`; awaiting the owner's review. Not merged.**
This is evidence for review, not a release claim. Forge Studio remains **not release-ready** (R-01 open).

Approved scope: signup baseline, server-side Turnstile, one-time replay-resistant tokens across instances,
per-device / IP / subnet limits, an opaque first-party Secure HttpOnly device cookie, a global threshold that challenges
and alerts without blindly blocking verified users, and a CAPTCHA outage that pauses only new guest registrations.

## 1. Commits
| Commit | Content |
|---|---|
| `f33c5e5` | docs: release re-audit for Track B's merge (based on `main` @ `80e02b5`), carried into this PR as its own commit |
| `472e9b8` | **red** regression tests (`tests/guest_protection.test.ts`, browser E2E `tests/e2e/captcha.e2e.test.ts`, siteverify stub) |
| `7384df5` | implementation |
| `871ded3` | contract tests + intended updates of existing tests |
| `07dd7ef` | verification additions (written after the implementation; not red-first) |
| later | docs only (this document, re-audit, checklist, API inventory) |

## 2. Baseline and red-first evidence (previous implementation, `main` @ `80e02b5`)
`tests/guest_protection.test.ts`: **17 of 17 failed**. Each failure is the vulnerability itself, not a setup error:

| Test | What the previous code did |
|---|---|
| A1 no CAPTCHA token | **20 of 20** guests minted with no verification at all |
| A1 verified-user lockout | after an IP-rotating attacker spent the global hourly budget, a fresh verified newcomer got **`429 guest_capacity`** (onboarding shut for everyone) |
| A2 verification | invalid, wrong-hostname, wrong-action and expired tokens: all `200` |
| A3 replay, 1 instance and 2 instances | **30 of 30** uses of one token minted guests |
| A4 budgets, 1 and 2 instances | one IP minted **10** (only the 10/min limiter applied; expected 5); a /24 and a /48 were unlimited |
| A5 proxy boundary | `200` × 6 where 2 were expected |
| A6 device cookie | no cookie (`null`); no device budget |
| A7 outage | provider down: still `200` (there was no verification to fail) |
| A8 config / production / hard ceiling | no `captcha` in `/api/config`; production started without any CAPTCHA; no configurable hard ceiling |
| A0 baseline | no `guestMints` in `/api/health/details` |

**Measured abuse capacity of the previous code (the baseline):**
* One client could mint guests with no challenge at **10 per minute per IP**.
* With rotating IPs it was bounded only by the **global 1 000 per hour**, which, once spent, **refused every new
  guest** (the lockout).
* There is no production traffic yet, so normal-traffic numbers do not exist. The new hourly series (§3) is how they will
  be measured.

Browser E2E red check: the CAPTCHA journey was run against the previous build in production mode (the old code
serves the build only there). A guest was minted, but **no Turnstile widget script was ever requested**, so the old
client never obtained or sent a token. (A first attempt failed for an unrelated reason: the old test-mode server
cannot serve the build. That run was discarded as not meaningful and is noted here for completeness.)

## 3. Design as implemented
| Requirement | Implementation | Defaults (env) |
|---|---|---|
| Server-side Turnstile | `TurnstileVerifier` POSTs `secret`, `response` and `remoteip` (the trusted client address) to siteverify with a hard timeout. Accepts only `success`, a hostname in `TURNSTILE_HOSTNAMES`, `action === "guest_mint"`, and `challenge_ts` no older than the maximum age. Provider-side configuration errors (`invalid-input-secret`, `missing-input-secret`, `internal-error`) are treated as an **outage** (503 + alert), never blamed on the user. | `TURNSTILE_TIMEOUT_MS=3000`, `TURNSTILE_MAX_TOKEN_AGE_S=300` |
| Single-use tokens | `sha256(token)` is redeemed **before** the provider is asked. PostgreSQL: `INSERT … ON CONFLICT` on `captcha_redemptions` (migration `0004`, primary key), so exactly one caller wins on any instance. JSON: in-process, atomic. Rows expire (max age + 60 s) and are swept. | — |
| Budgets | All or nothing in one transaction (`takeWindows`, rows locked in key order). Keys: device `gm:dev:<sha256(cookie)>` (per day), IP `gm:ip:<addr>`, network `gm:net:v4:a.b.c.0/24` or `gm:net:v6:xxxx:xxxx:xxxx::/48` (per hour). IPv4-mapped IPv6 is folded to IPv4, and IPv6 is canonicalised. **Only CAPTCHA-verified requests spend budgets**, so unverified floods cannot exhaust a shared subnet. The existing 10/min per-IP pre-filter stays in front. | device 3/day, IP 5/h, subnet 30/h |
| Device cookie | `__Host-fs_dev=<22-char base64url, 128-bit random>; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`, no `Domain`. Only `sha256(value)` is used as a key. Nothing derives from the IP, the user agent or the user. A value not exactly in this format is replaced, never trusted. | — |
| Global threshold | `GUEST_MINT_SOFT_PER_HOUR` (the former `GUEST_MINT_PER_HOUR` is still honoured as a fallback). When reached: an alert `guest_mint_soft_threshold` (once per hour per instance), and the IP and subnet budgets are halved for the rest of the hour. **It never rejects a CAPTCHA-verified sign-up.** | 1 000/h |
| Hard ceiling | `GUEST_MINT_HARD_PER_HOUR`, all instances. `429 guest_capacity` with a sign-in path, plus an alert. **Off by default** (see §3.1 item 5). | 0 (off) |
| CAPTCHA outage | timeout, 5xx, malformed body, unreachable host or a provider config error: `503 captcha_unavailable` + `Retry-After: 30` for the new guest, and an alert `captcha_provider_unavailable` (at most once a minute per instance). Nothing else calls the provider, so **existing guest sessions and signed-in users are unaffected by construction** (tested). | — |
| Baseline (A0) | Every mint increments `stats:guest-mint` per hour, and every refusal increments `stats:guest-reject:<code>`. `/api/health/details` → `guestMints`: `thisHour`, thresholds, budgets, rejections this hour by reason, and the **30-day hourly series** (shared by all instances on PostgreSQL). The window sweep keeps `stats:*` rows 30 days and limit windows 48 h. | — |
| Configuration safety | Production requires `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` and `TURNSTILE_HOSTNAMES` unless `CAPTCHA_REQUIRED=false`, which is logged as `captcha_disabled`. A non-HTTPS `TURNSTILE_VERIFY_URL` is refused in production, so a test stub can never be selected there. The secret is sent only to siteverify: it is not in logs, errors, `/api/config` or diagnostics (tested). | production: required |
| Client (A8) | Before the first guest mint the SPA reads `features.captcha` from `/api/config`, loads the Turnstile script, renders the widget in a small overlay with action `guest_mint`, and sends the token once. Refusals map to clear messages (outage, rate limit, capacity → "sign in to continue"). | — |

Response codes of `POST /api/auth/guest`:

| Code | Meaning |
|---|---|
| `403 captcha_required` | no token was sent |
| `403 captcha_failed` | the token was invalid, for the wrong hostname or action, or too old (`reason` says which) |
| `403 captcha_replayed` | the token was already used, on any instance |
| `503 captcha_unavailable` | the CAPTCHA provider is unavailable; only new guests are affected |
| `429 guest_rate_limited` | a budget is spent; `scope` is `device`, `ip` or `subnet`, with `Retry-After` |
| `429 guest_capacity` | the hard ceiling was reached (only when it is configured) |

### 3.1 Deviations from the approved plan (for the reviewer's decision)
1. **Migration number:** `0004_captcha_redemptions.sql`. The plan said `0003_captcha_redemptions`, but `0003` is Track B's
   `0003_render_queue.sql`. The budgets and the baseline reuse the existing `window_counters` table, so there is no
   schema change for them.
2. **Fixed windows, not token buckets.** The plan said budgets would live on the PostgreSQL token buckets. They use fixed
   hourly and daily windows instead, which match "N per hour / per day" exactly and allow all-or-nothing across keys.
   Trade-off: at a window boundary a client can spend up to 2 × N within a short span.
3. **Device id is the cookie only.** The plan said cookie *plus* localStorage. A localStorage copy is readable by page
   JavaScript, which defeats the HttpOnly property. The cookie is issued with the first mint response, not at first page
   load.
4. **Soft-threshold escalation = halved budgets + alert, not a "forced interactive challenge".** An interactive-only
   challenge needs a second Turnstile widget (its own site key and secret). Every guest mint is already challenged.
5. **Hard ceiling off by default.** Your condition was that the value comes from measured peak, not a guess, and there is
   no production or staging traffic yet to measure. Until 14 days of the new series exist, storage stays protected by
   the existing guest storage pool cap (`GUEST_POOL_MAX_MB`): a guest token is stateless, so minting costs no storage
   until the guest saves. **Decision needed:** keep it off until measured, or set a provisional value now.
6. **No emergency mint budget during an outage.** The plan listed a per-instance emergency budget with default 0; that
   is the same behaviour as not having one, so it was not built.
7. **The token is burned even when verification fails or the provider is down**, because redemption comes first. That
   is what makes replay impossible. The user simply solves a new challenge.
8. **The test "stub verifier"** is a local HTTP siteverify stand-in instead of a stub class, so the real verifier code
   path is tested. It cannot be selected in production (HTTPS only).

## 4. Test evidence
* **`tests/guest_protection.test.ts`: 20 tests.**
  * The 17 red-first tests (A0–A8), plus 3 verification additions written after the implementation:
    * a provider configuration error is a 503, not a 403;
    * an existing guest keeps working when the hard ceiling refuses new guests;
    * a malformed device cookie is replaced, never trusted.
  * Coverage includes:
    * replay with 20 concurrent uses on 1 instance and 30 concurrent across 2 instances;
    * every budget exact under 50 concurrent requests on 1 and on 2 instances;
    * IPv4, IPv6 `/48` and IPv4-mapped IPv6;
    * `TRUST_PROXY=1` (a spoofed X-Forwarded-For prefix is ignored, and `remoteip` is the proxy-appended address) and
      `TRUST_PROXY=none`;
    * provider timeout, 5xx, malformed body, unreachable host and recovery;
    * verified users unaffected by the outage, the soft threshold and the hard ceiling.
* **`tests/repo_contract.test.ts` (both backends):**
  * all-or-nothing windows, where a refused call consumes nothing;
  * single use with expiry;
  * statistics.
  * PostgreSQL only:
    * 25 concurrent redemptions → exactly 1;
    * windows exact under 40 concurrent calls, with no leftover increments;
    * the sweep keeps statistics 30 days and limit windows 48 h.
* **`tests/e2e/captcha.e2e.test.ts`:** the production build in the browser fetches the site key, renders the widget
  with action `guest_mint`, and sends the token, which the server verifies. Cloudflare is not contacted: the widget
  script is intercepted, and siteverify is the stub.

Results: §6.

## 5. Intended changes to existing behaviour and tests
| Change | Why |
|---|---|
| `GUEST_MINT_PER_HOUR` no longer hard-rejects. It is the soft threshold; the hard cap is `GUEST_MINT_HARD_PER_HOUR` (`phase1` and `phase2` tests updated) | the approved "never blindly block verified users" |
| `/api/config` gains `features.captcha` (`null` when off) (`api.test.ts` updated) | the client needs the public site key |
| production requires Turnstile unless `CAPTCHA_REQUIRED=false` (the production E2E journey and the CI Docker smoke set it, and CI now also asserts the refusal) | approved A2 |
| the test helper gives generous guest budgets by default | existing tests mint many guests from `127.0.0.1` |

No assertion was weakened, and no test was skipped.

## 6. Gate results
_Filled in after the runs complete._

## 7. Risk register (Track A)
| # | Risk | Note |
|---|---|---|
| 1 | **Shared networks.** The defaults (5/h per IP, 30/h per /24, halved above the soft threshold) can refuse guest sign-up to people behind one NAT (schools, offices, mobile CGNAT). | Only new **guests** are affected; signing in always works. All values are configurable. Tune them from the baseline series. |
| 2 | The device budget is not a defence against scripts (they can drop cookies). | By design: scripts are held back by the CAPTCHA and the IP and subnet budgets. |
| 3 | Fixed-window boundary: up to 2 × N in a short span around the hour (or day) edge. | Accepted trade-off (§3.1 item 2). |
| 4 | **No live Cloudflare validation.** Only the documented siteverify contract is exercised, against a stub. | The owner must create a Turnstile widget (free) and store the secret; a live check follows (owner action). |
| 5 | Cloudflare outage = guest sign-up paused. | By design; existing users are unaffected; signing in still works. |
| 6 | No hard ceiling until measured. | Decision needed (§3.1 item 5). Storage is bounded by the guest pool cap meanwhile. |
| 7 | JSON backend: redemptions, windows and statistics are in memory (lost on restart). | JSON is single-instance (development and rollback target). PostgreSQL is the production target. |
| 8 | Rollback: the previous release ignores `captcha_redemptions` but its sweep deletes `stats:*` rows older than 48 h. | A rollback loses baseline history older than 48 h, not functionality. |
| 9 | Junk redemptions from invalid tokens. | Bounded by the 10/min per-IP pre-filter; rows expire after about 6 minutes and are swept. |
| 10 | Soft-threshold escalation is budget halving, not an interactive-only challenge. | §3.1 item 4. |
| 11 | ASN-level budgets not built. | Deferred by owner decision (needs a GeoIP/ASN licence). |

## 8. Privacy-policy draft text (A9, for the owner's approval)
> **Security cookie.** When you continue as a guest, Forge Studio sets one first-party cookie, `__Host-fs_dev`. It
> contains a random value that identifies your browser only to us. It contains no personal information and is not
> derived from your IP address, your device or your account. We use it only to limit how many guest sessions one
> browser can start, to prevent abuse. It is not used for analytics, advertising or tracking across sites. It is
> strictly necessary for security, expires after one year, and can be deleted at any time in your browser settings.
>
> **Verification.** To prevent automated abuse, starting a guest session uses Cloudflare Turnstile. Cloudflare
> processes technical information from your browser to decide whether the request is automated; see Cloudflare's
> privacy policy. We send Cloudflare the verification token and your IP address, and keep only a one-way hash of the
> token for a few minutes to stop it from being reused.

## 9. Before Track A can go live (owner actions, not code)
1. Create a Cloudflare Turnstile widget (free tier) for the production hostname(s), action `guest_mint`.
2. Store `TURNSTILE_SECRET` in the secret manager. The site key and hostnames are configuration. Claude never handles
   the secret's value.
3. Approve or adjust the privacy text (§8).
4. Decide the hard ceiling (§3.1 item 5) and review the default budgets for expected shared-network users (§7 risk 1).
