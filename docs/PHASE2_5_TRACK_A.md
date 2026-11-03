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
| Budgets | All or nothing in one transaction (`takeWindows`, rows locked in key order). Keys: device `gm:dev:<sha256(cookie)>` (per day), IP `gm:ip:<addr>`, network `gm:net:v4:a.b.c.0/24` or `gm:net:v6:xxxx:xxxx:xxxx::/48` (per hour). IPv4-mapped IPv6 is folded to IPv4, and IPv6 is canonicalised. **Only CAPTCHA-verified requests spend budgets**, so unverified floods cannot exhaust a shared subnet. The existing 10/min per-IP pre-filter stays in front. | device 3/day, IP 20/h, subnet 100/h (owner-approved 2026-11-03; were 5/h and 30/h) |
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

## 6. Gate results (local: PostgreSQL 16, Playwright Chromium)
Three gates were run. The first two **failed** and are recorded here; each fix was test infrastructure only.

**Gate 1, code `07dd7ef`: FAILED (PostgreSQL only).**
* JSON: the new tests passed 55/55 × 3 and the full suite 249/0 failed.
* With every server on PostgreSQL the new tests failed **14–15 of 55 in all three runs**, and the full suite failed 5.
* Root cause: `sorry, too many clients already`. The Track A test file kept every server alive until the file ended;
  about 20 servers × a pool of 10 exhausted `max_connections` (100). In the replay test the property itself still held
  (exactly one `200`); only the extra `503 database_unavailable` responses broke the assertion.
* Fix `d7ad0ce`: tear down after each test.

**Gate 2, code `d7ad0ce`: FAILED (full PostgreSQL suite only).**
* New tests: 55/55 × 3 on both backends. JSON full suite: 249/0 failed. E2E: 2/2 on both backends.
* The full PostgreSQL suite failed **8** tests (Track B B6/B7/B9 and R-02), all `too many clients`. The test files run in
  parallel and the added Track A tests pushed the combined peak over the limit.
* A measured rerun **peaked at 98 of 100 connections and stalled**.
* Fix `817f204`: test servers default to `DATABASE_POOL_MAX=4`. Production is unchanged (10). No Track B code or test
  changed.
* Remeasured: peak 92 (brief spikes; 7 of 241 samples ≥ 85; most of the run < 40), suite green.

**Gate 3, code `817f204`: PASSED, one uninterrupted sequence, no retries:**

| Check | JSON | PostgreSQL |
|---|---|---|
| New tests (`guest_protection` + `repo_contract`), run 1 / 2 / 3 | 55/55, 55/55, 55/55 | 55/55, 55/55, 55/55 |
| Full suite | 251 tests, 249 pass, **0 fail**, 2 skipped | 251 tests, 242 pass, **0 fail**, 9 skipped |
| Production build | pass | — |
| Browser E2E (guest journey + CAPTCHA journey) | 2/2 | 2/2 |

Skips: 2 live Gemini tests on both backends (no key, "NOT passed"; R-01); 7 JSON-only tests on PostgreSQL.

## 7. Risk register (Track A)
| # | Risk | Note |
|---|---|---|
| 1 | **Shared networks.** Approved defaults: 20/h per IP, 100/h per /24 and /48, halved above the soft threshold. A large office or carrier NAT gets 20 new guest sessions per hour per public IP. | Only new **guests** are affected; signing in always works. Verified requests refused by the IP or subnet limit are recorded **separately** (`guestMints.networkRefusals`, 30-day series), apart from abuse signals (CAPTCHA failures). Review the limits against real traffic; **never tighten them silently** (owner decision). |
| 2 | The device budget is not a defence against scripts (they can drop cookies). | By design: scripts are held back by the CAPTCHA and the IP and subnet budgets. |
| 3 | Fixed-window boundary: up to 2 × N in a short span around the hour (or day) edge. | **Accepted by the owner, with monitoring** (§10). |
| 4 | **No live Cloudflare validation.** Only the documented siteverify contract is exercised, against a stub. | The owner must create a Turnstile widget (free) and store the secret; a live check follows (owner action). |
| 5 | Cloudflare outage = guest sign-up paused. | By design; existing users are unaffected; signing in still works. |
| 6 | No hard ceiling until measured. | **Owner decision: off** (`GUEST_MINT_HARD_PER_HOUR=0`). After 14 days of traffic, the 10 × p99 value is proposed for approval; it is never enabled automatically. Storage stays bounded by the guest pool cap meanwhile. |
| 7 | JSON backend: redemptions, windows and statistics are in memory (lost on restart). | JSON is single-instance (development and rollback target). PostgreSQL is the production target. |
| 8 | Rollback: the previous release ignores `captcha_redemptions` but its sweep deletes `stats:*` rows older than 48 h. | A rollback loses baseline history older than 48 h, not functionality. |
| 9 | Junk redemptions from invalid tokens. | Bounded by the 10/min per-IP pre-filter; rows expire after about 6 minutes and are swept. |
| 10 | Soft-threshold escalation is budget halving plus an alert. **This is not equivalent to a forced interactive challenge.** Every new guest still needs a CAPTCHA. | **Accepted temporarily** by the owner (§10). |
| 11 | ASN-level budgets not built. | Deferred by owner decision (needs a GeoIP/ASN licence). |
| 12 | **Test connection headroom.** The full PostgreSQL suite peaks at 92 of 100 connections (brief spikes) even with test pools of 4. A future test added in parallel could exhaust it again. | Test infrastructure, not production. If CI shows it, raise the CI database's `max_connections` rather than shrinking pools further. |

## 8. Privacy notice: approved draft (owner, 2026-11-03)
Status: **approved as a draft**, including the owner's edit (the 35-day paragraph). **It is not final legal clearance:**
the complete privacy policy must be reviewed before public launch. Hashed identifiers are **pseudonymous security
identifiers, not anonymous data**.

> **Starting a guest session.** To protect Forge Studio from automated sign-ups, starting a guest session involves three things:
>
> **1. A security cookie.** We set one first-party cookie, `__Host-fs_dev`, containing a random value. It contains no personal information and is not derived from your IP address, your device or your account. It is used only to limit how many guest sessions one browser can start. It is never used for analytics, advertising or cross-site tracking. It is strictly necessary for security, lasts **one year**, and you can delete it at any time in your browser settings. Our servers keep only a one-way hash of it (a pseudonymous security identifier), and only for up to **2 days**.
>
> **2. Your IP address.** We limit how many new guest sessions can be started from one IP address, and from one network block (the first three parts of an IPv4 address, or the first 48 bits of an IPv6 address), within an hour. For this we keep your IP address and network block for up to **2 days**. They are not written to our request logs. If many people share your connection (an office, a school or a mobile network), you may occasionally be asked to try again later or sign in instead.
>
> **3. Verification by Cloudflare.** We use Cloudflare Turnstile to tell people from automated scripts. Cloudflare processes technical information from your browser to make this decision (see Cloudflare's privacy policy). We send Cloudflare the verification result your browser produced and your IP address. We keep only a one-way hash of that result, for about 10 minutes, so it cannot be reused.
>
> **Other security and usage limits.** Separately from guest registration, Forge Studio uses IP addresses for existing rate-limiting and AI usage-quota enforcement. Some of these records may be retained for up to 35 days to enforce usage limits and protect the service.
>
> Signing in with an account is never subject to the guest-registration limits.

What is stored, hashed, logged and retained (verified against the code on `e64615b`):

| Data | Where | Form | Retention |
|---|---|---|---|
| `__Host-fs_dev` value | user's browser | random 128-bit value | 1 year |
| Device identifier | limit counters (`gm:dev:*`) | SHA-256 (pseudonymous) | at most about 49 h (deleted 48 h after the window starts; the sweep runs every 5 min) |
| IP address | limit counters (`gm:ip:*`) | plain text | at most about 49 h |
| IPv4 /24 or IPv6 /48 | limit counters (`gm:net:*`) | plain text | at most about 49 h |
| CAPTCHA token | `captcha_redemptions` | SHA-256 | about 6 min, deleted within about 11 min |
| Token and IP | sent to Cloudflare siteverify | as is | Cloudflare's policy |
| Guest-mint statistics | `stats:*` counters | counts only, no identifiers | 30 days |
| Request logs | server logs | time, path, status, duration, user kind (no IP, token or cookie) | per log retention |
| Existing per-minute rate limits | `rate_buckets` | IP in plain text | about 10 idle minutes |
| Existing daily AI quota | `ai_usage_daily` | IP in plain text | 35 days |

## 9. Before Track A can go live (owner actions, not code)
1. Create a Cloudflare Turnstile widget (free tier) for the production hostname(s), action `guest_mint`.
2. Store `TURNSTILE_SECRET` in the secret manager. The site key and hostnames are configuration. Claude never handles
   the secret's value.
3. Approve or adjust the privacy text (§8).
4. Decide the hard ceiling (§3.1 item 5) and review the default budgets for expected shared-network users (§7 risk 1).

## 10. Owner decision record (2026-11-03)
| Item | Decision | Condition / follow-up |
|---|---|---|
| Hard ceiling | **Off by default** (`GUEST_MINT_HARD_PER_HOUR=0`); no arbitrary cap | Collect 14 days of real traffic, compute 10 × p99 from `guestMints.series`, and **bring the number back for approval**; never enabled automatically |
| `/api/health/details` exposure | Verified restricted | 404 without the diagnostics token or an admin identity (R-12); public endpoints carry no guest-mint metrics (test `A-decisions`) |
| Network limits | **Approved:** device 3/day, IP 20/h, IPv4 /24 100/h, IPv6 /48 100/h; soft-threshold halving kept | Shared-network refusals recorded separately (`guestMints.networkRefusals` and `rejected['guest_rate_limited:ip' / ':subnet']`), apart from CAPTCHA failures. Review against real traffic; do not tighten silently. |
| Privacy notice | **Approved with edit, as a draft** (§8) | The 35-day IP retention for existing rate limits and AI quotas is disclosed; hashed identifiers are called pseudonymous; **legal review of the full policy before public launch** |
| Cookie only, no localStorage copy | **Accepted** | `HttpOnly` and `Secure` are kept (test A6) |
| Weaker escalation after the soft threshold | **Accepted temporarily** | Every new guest still needs a CAPTCHA. Documented as **not equivalent** to a forced interactive challenge (risk 10). |
| No emergency guest budget in a CAPTCHA outage | **Accepted** | Fail closed for new guests only; existing guests and signed-in users stay functional (test A7) |
| Fixed-window boundary burst | **Accepted, with monitoring** | Up to 2 × N around a window edge (risk 3) |
| Evidence limitation | Recorded | The fetched CI log starts at `npm test`; checkout, install and typecheck are evidenced by step status only |

