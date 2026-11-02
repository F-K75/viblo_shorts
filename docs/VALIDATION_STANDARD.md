# Release Validation Standard (applies to every phase from now on)

## Why this exists
The Phase 2 validation gate passed while a PostgreSQL deadlock (R-02) was in the code. The gate tested the
behaviours we had thought of (parallel saves, parallel reservations, parallel job claims) but not the
**interaction** between two paths: concurrent *refunds* racing *reservations* on a shared key. It also had no
abuse tests for the free tier (R-03/R-04). A happy-path pass — or a pass of only the scenarios the author
imagined — is not evidence of correctness.

## Required layers for every phase gate
| Layer | Minimum requirement | Where |
|---|---|---|
| Unit | Pure logic and every new branch; property-style checks for parsers and filters | `tests/*.test.ts` |
| Integration | Real server process over HTTP; every changed route; error paths (400/404/409/413/429/503/507) | `tests/api.test.ts`, phase suites |
| **Real database** | All of the above **also** on PostgreSQL (`TEST_STORAGE_BACKEND=postgres`); CI sets `REQUIRE_PG_TESTS=1` so DB tests can never silently skip | CI `test` job |
| **Concurrency** | For every shared mutable row or table touched by the change: ≥ 2 instances, ≥ 50 concurrent operations, **mixing every code path that touches it** (e.g. reserve + refund + expiry), asserting final counters exactly; 3 consecutive green runs | `tests/concurrency.test.ts` |
| **Failure injection** | DB outage (TCP proxy) mid-request and mid-transaction; timeouts; corrupt inputs; crash between steps (e.g. reserve without settle) | `tests/phase2.test.ts`, `tests/hardening.test.ts` |
| **Security and abuse** | For every new endpoint or limit: authorization (foreign ids → 404), injection/size limits, and a **free-tier abuse scenario** asking whether an anonymous or guest attacker can deny service to a signed-in user | abuse probes → regression tests |
| Browser E2E | The full user journey on the production build, on both backends | `tests/e2e/` |
| **Regression** | Every previously found issue keeps a test that fails if it returns (FS-*, R-*); red-before-green recorded for each fix | phase suites |
| Load | `npm run test:load` on PostgreSQL: **0 × 5xx**, p95 recorded and compared with the previous phase | `scripts/loadtest.ts` |
| CI | All of the above green on the PR head, logs read (not only the check colour) | GitHub Actions |
| Live providers | Real Gemini, Firebase and Drive when the phase touches them; reported as **skipped ≠ passed** | `tests/llm.live.test.ts` |

## Rules
1. **Red before green.** Each fix is accompanied by a test shown to fail on the old code. When that is technically
   impossible (e.g. the test needs a new export), say so and give the alternative evidence.
2. **Non-vacuous assertions.** A test proving "X is retried" must show X actually happened (e.g. assert the retry
   counter moved).
3. **Concurrency is a matrix, not a test.** List every writer to each shared row and test each pair concurrently.
4. **Independent re-audit before merge** for phases that change storage, auth or limits: re-derive the risks from
   the code, not from the previous report.
5. **Score ≠ readiness.** Track milestones (below) and named blockers; a number never overrides an open P0/P1.

## Milestones
| Milestone | Required outcome |
|---|---|
| Phase 1 | Storage safety and data integrity |
| Phase 2 | Durable PostgreSQL architecture |
| Phase 2.5 | Abuse protection and concurrency |
| Phase 3 | Functional AI product and user journeys |
| Phase 4 | Security, compliance and operations |
| Phase 5 | Production deployment and verification |

**Non-negotiable release condition:** real Gemini generation demonstrated with an **actual API call**, followed by
successful rendering, preview and export of the generated video. A mocked Gemini response does not count.
