# QA & Test Strategy Audit

**File:** `engineering/QA_AUDIT.md`  
**Scope:** `tests/`, `package.json` scripts, CI test suites (`.github/workflows/ci.yml`)  
**Reference Codebase Commit:** `dffa550` (main branch)

---

## 1. Executive Summary

The Forge Studio test suite is comprehensive and heavily focused on regression prevention, storage contract compliance, concurrency safety, and system resilience. It includes unit tests, integration tests against live PostgreSQL instances, child-process FFmpeg queue validations, memory protection tests, and Playwright end-to-end browser tests.

### Top Findings & Observations
1. **[Pass] Dual Backend Contract Testing:** `tests/repo_contract.test.ts` executes the exact same contract test suite against both the PostgreSQL backend (`pgRepo.ts`) and JSON shard backend (`jsonRepo.ts`), verifying feature parity across storage implementations.
2. **[Pass] Concurrency & Race-Condition Verification:** Dedicated test suites (`tests/concurrency.test.ts`, `tests/memory_protection.test.ts`, `tests/render_queue.test.ts`) exercise concurrent reservations, job queue locking (`SKIP LOCKED`), and process memory budgets.
3. **[Pass] End-to-End Integration in CI:** `.github/workflows/ci.yml` runs full Playwright browser tests on both JSON and PostgreSQL configurations (`browser.e2e.test.ts`, `captcha.e2e.test.ts`).
4. **[Pass] Offsite Backup & Restore Verification:** `tests/backup_restore.test.ts` and `tests/restore_atomic.test.ts` test end-to-end `age` encryption, S3 streaming upload, and atomic database restoration.
5. **[Medium] Sandboxed Local Execution Dependency:** Test scripts run via `tsx --test` (Node.js test runner). In restricted local sandbox environments without node binary host execution access, execution requires elevated permissions or containerized runners (`docker-compose` / CI runner).

---

## 2. Test Suite Inventory

| Test Suite | Purpose | Target Modules |
|---|---|---|
| `tests/repo_contract.test.ts` | Validates CRUD, user isolation, and query constraints across Postgres & JSON. | `server/lib/repo.ts`, `pgRepo.ts`, `jsonRepo.ts` |
| `tests/render_queue.test.ts` | Tests child-process concurrency limits, queue ordering, timeouts, and job cancellation. | `server.ts` render queue, FFmpeg runner |
| `tests/auth_llm_storage.test.ts` | Tests bearer token parsing, RS256 Firebase auth, guest tokens, and LLM output parsing. | `server/lib/auth.ts`, `server/lib/llm.ts` |
| `tests/security.test.ts` | Tests SSRF guard (private IPs blocked), URL host allowlists, drawtext escaping. | `server/lib/security.ts` |
| `tests/guest_protection.test.ts` | Tests guest project retention limits, expiration sweeping, and claim mechanics. | `server/lib/guestProtection.ts` |
| `tests/backup_restore.test.ts` | Verifies `pg_dump`, `age` asymmetric encryption, and restore integrity. | `server/db/offsiteBackup.ts`, `scripts/backup.ts` |
| `tests/migrations.test.ts` | Exercises forward schema migrations and rollback integrity under advisory locks. | `server/db/migrate.ts`, `server/db/migrations/*` |
| `tests/concurrency.test.ts` | Tests concurrent project writes and optimistic concurrency conflicts. | `server/lib/projectStore.ts`, `pgRepo.ts` |
| `tests/memory_protection.test.ts` | Tests heap limits, buffer sizes, and stream backpressure on large payloads. | `server/lib/requestGuards.ts`, `storage.ts` |
| `tests/youtube.test.ts` | Tests URL validation, caption transcript parsing, and timestamp alignment. | `server/lib/youtube.ts` |
| `tests/e2e/browser.e2e.test.ts` | Playwright browser E2E test verifying full user journey from home to preview. | React SPA, Express backend |
| `tests/e2e/captcha.e2e.test.ts` | Validates Turnstile CAPTCHA gating on guest token issuance. | `src/utils/captcha.ts`, `server.ts` |
| `tests/llm.live.test.ts` | Optional live API test suite running against real Gemini endpoints in CI. | `server/lib/llm.ts`, `@google/genai` |

---

## 3. Automation & CI Coverage

* **Node.js Test Runner:** Tests use Node's built-in `node:test` runner executed via `tsx --test`, eliminating heavy external test runner overhead (e.g. Jest / Mocha).
* **CI Matrix:**
  * Step 1: Typecheck (`npm run lint` -> `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`).
  * Step 2: Unit + integration tests on JSON backend (`npm test`).
  * Step 3: Integration tests on PostgreSQL (`TEST_STORAGE_BACKEND=postgres npm test`).
  * Step 4: Playwright browser tests on both storage backends.
  * Step 5: `bun audit --audit-level=high`.
  * Step 6: Multi-instance container smoke test (verifying shared Postgres state across instances).

---

## 4. Recommendations

1. **Frontend Unit Test Suite:** While E2E Playwright coverage is strong, adding Vitest unit tests for isolated React components (`CaptionStyleConfig.tsx`, `ScriptEditor.tsx`) would accelerate feedback loops.
2. **Coverage Metric Reporting:** Integrate `c8` or Node's native code-coverage reporter (`--experimental-test-coverage`) into the CI pipeline to generate explicit coverage percentages on PRs.
3. **Flakiness Safeguards:** Ensure E2E tests against live DOM animations in `ShortsPlayer.tsx` utilize Playwright web assertions (`expect(locator).toBeVisible()`) rather than fixed sleep delays.

