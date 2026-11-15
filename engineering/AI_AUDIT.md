# AI & LLM Integration Audit

**File:** `engineering/AI_AUDIT.md`  
**Scope:** `server/lib/llm.ts`, `server/lib/usage.ts`, `@google/genai` integration, prompt management, rate/budget controls  
**Reference Codebase Commit:** `dffa550` (main branch)

---

## 1. Executive Summary

Forge Studio uses Google Gemini via the official `@google/genai` (v2.24.0) SDK for script breakdown, scene hook generation, caption timing suggestions, and text-to-speech. AI integration is designed defensively: all LLM inputs are delimited to mitigate prompt injection, outputs are parsed through a multi-stage validation and repair pipeline (`jsonrepair`), and provider quota usage is tracked via an atomic, two-phase reservation ledger.

### Top Findings & Observations
1. **[Pass] Prompt Injection Mitigation:** User input is sanitized and framed using `quoteUserInput` in `server/lib/llm.ts` (stripping enclosing XML/HTML delimiters before prompt interpolation).
2. **[Pass] Defensive Output Parsing:** `cleanAndParseJSON` strips Markdown code fences and uses `jsonrepair` before executing structural validation in `validateScript`. Invalid or truncated outputs fail gracefully without breaking the runtime.
3. **[Pass] Atomic Quota & Billing Reservation:** `server/lib/usage.ts` implements a two-phase check-and-increment reservation ledger (`reserve()` -> provider call -> `settle()`), preventing double-spends and race conditions.
4. **[Pass] Fails Closed on Corrupt Ledger:** If the usage tracking store becomes unreadable, `UsageLedger` refuses calls with a 503 rather than permitting unmetered access.
5. **[Medium] Hardcoded Fallback Models:** Primary and fallback Gemini models are configured in environment variables, but model string fallbacks are partially hardcoded in `server.ts` if env vars are unset.

---

## 2. Model Selection & Configuration

* **Provider:** Google Gemini API (`@google/genai` v2.24.0).
* **Configurable Envs:**
  * `GEMINI_API_KEY`: API authentication key.
  * `GEMINI_MODEL`: Model name (defaults to current recommended Gemini Flash model).
  * `GEMINI_FALLBACK_MODEL`: Secondary model invoked on upstream 429 / 503.
* **Timeout & Retries:** AI invocation enforces request-level timeouts (15s) and bounded retries (maximum 2 attempts per request) across fallback models.

---

## 3. Prompt Construction & Schema Validation

### Sanitization (`server/lib/llm.ts` lines 77-80)
```typescript
export function quoteUserInput(tag: string, value: string): string {
  const safe = String(value || '').replace(/<\/?[a-z_]+>/gi, '');
  return `<${tag}>${safe}</${tag}>`;
}
```
All dynamic inputs (user topic, audience, custom script, YouTube captions) are bounded and wrapped within explicit XML-style tags, instructing the model to treat the content strictly as data.

### Structural Validation (`validateScript`)
Output objects are enforced against the `ValidatedScript` contract:
* `beats`: Array of 2 to 10 scene objects with bounded `text` (max 300 chars) and `visual_keywords` (max 80 chars).
* `hashtags`: Normalized with `normalizeHashtags()`, deduplicated, prefixed with `#`, and guaranteed to include `#shorts`.
* `hook` & `title`: Clamped to safe UI display lengths (200 and 100 characters, respectively).

---

## 4. Quota, Cost Tracking, and Abuse Prevention

* **Persistence:** `UsageLedger` persists usage to `DATA_DIR/usage.json` (or PostgreSQL `ai_usage_daily` table when running on Postgres).
* **Two-Phase Reservation:**
  1. `reserve([{ key: 'ai_user_' + uid, limit: 50 }], reqId)`: Synchronously checks limit and reserves 1 unit.
  2. `beginAttempt(reqId)`: Persisted immediately prior to calling `@google/genai`.
  3. `settle(reqId, 'usage' | 'refund')`: Settles billable attempts or restores unused quota upon provider error.
* **Crash Recovery:** Unsettled reservations lingering after server restart are inspected and settled on boot to prevent quota leakage.

---

## 5. Recommendations

1. **Structured Outputs Mode:** Transition prompts to Gemini's native `responseSchema` configuration in `@google/genai` for guaranteed JSON structure adherence at the API level.
2. **Context Window Telemetry:** Add explicit token counting via the Gemini SDK's `countTokens` endpoint before generation to avoid unexpected context overflows on lengthy YouTube transcripts.
3. **Model Deprecation Monitoring:** Implement automated alerting if Gemini API calls return deprecation headers for configured model aliases.

