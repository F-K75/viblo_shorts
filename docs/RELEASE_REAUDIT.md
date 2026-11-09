# Forge Studio — Independent Re-audit + Corrective Round

## Phase 2.5 Track D-1: MERGED (PR #7 → `main` @ `39f2000`, 2026-11-09)
* **Merged by the repository owner** on 2026-11-09 at 14:52:42 UTC (20:22:41 IST), as merge commit
  `39f20005c9cd0227eb2d6334e9f15e1637cb7074`.
* **Merge provenance:**
  * GitHub records `merged_by: F-K75`. The merge commit carries GitHub's default title ("Merge pull request #7 from
    F-K75/claude/keen-feynman-xtbvz2-track-d1"), which GitHub uses when the merge sets none (for example, the web
    merge button).
  * The owner confirmed on 2026-11-09 that they merged PR #7 themselves.
  * The Claude Code session did not initiate the merge. This session's transcript has merge calls only for PRs #2–#6,
    each made with the owner's explicit approval, and no auto-merge call.
  * For a while, before the owner's confirmation, this provenance was treated as unverified and recorded as a
    possible authorization anomaly (PR #8 review). It is resolved: an owner-initiated merge of the reviewed head.
* **Parents:**
  * `6ee9c11f6ed58e2cee8816a187a5bf3f3126550c`: the previous `main` (Track A merge);
  * `6b39e4bb171e79d8c631de0d5aa5e2b933316eeb`: the reviewed D-1 head, the final head of the second review pass.
* **Tree equivalence.** The merge commit's tree is identical to the reviewed head's tree (`bdfa72e1…`;
  `git diff 6b39e4b 39f2000` is empty). No code beyond the reviewed head entered `main`.
* **Pre-merge CI on the reviewed head:** run 59 (`6b39e4b`) and run 56 (`7e09960`, the final code commit). Both
  green, every job's log read.
* **Post-merge CI, run 60** (`42638978970`, `push` to `main` @ `39f2000`): **green, every job's log read.**

| Job | Result (from the log) |
|---|---|
| `test`: JSON suite | 287 tests, 285 pass, **0 fail**, 0 cancelled, 2 skipped |
| `test`: every server on PostgreSQL | 287 tests, 278 pass, **0 fail**, 0 cancelled, 9 skipped |
| `test`: build, E2E, audit | build passes; E2E JSON 2/2, PostgreSQL 2/2; `bun audit --audit-level=high`: "No vulnerabilities found (checked 389 packages, 2 below --audit-level=high, 1 ignored)"; no failing test line in the fetched log, which is capped at 5 000 lines |
| `test`: E2E step's throwaway Playwright install | npm prints "5 vulnerabilities (1 moderate, 4 high)" (D9) |
| `docker` (2 264 lines, 0 `##[error]`) | migrations `0001`–`0006` applied (`"version":6`); production refuses unsafe configuration (exit 1 each). **D2:** restore exit 137, app exit 1, "volume unchanged by the refused start (11 files, sha256 identical)", `"state": "rolled-back"`, "D2 PASSED". **D7:** "ff-normal PASSED … no orphan", "ff-forced PASSED … no orphan", "D7 PASSED". |
| `live-llm` | runs on `push` and is **green with 0 live tests**: both tests skipped, "GEMINI_API_KEY not set … (NOT passed)". **Not live validation.** |

* **Skips:**
  * 2 live Gemini tests per backend (no `GEMINI_API_KEY`);
  * 7 JSON-only tests on PostgreSQL;
  * no D-1 test.
* **The merge is not authorization for further work.** D-2 and Track E each need separate approval. Production
  deployment is not approved.

### Release position after Tracks C, B, A and D-1 (production release NOT approved)
| Track | State |
|---|---|
| C, memory protection (R-13) | merged (`53fc724`) |
| B, render queue and billing (R-04, F7) | merged (`80e02b5`) |
| A, guest registration protection (R-03) | merged (`6ee9c11`) |
| D-1, security and data hardening (F8–F11, D6, D2, D7; review items R1–R6) | **merged (`39f2000`)** |
| D-2 (D1, D3, D5, D8, D9, D10) | **not started; not authorized** |
| E, live Gemini validation (R-01) | **not started; not authorized** |

**Remaining release blockers and requirements:**
1. **R-01, live Gemini validation.** CI's `live-llm` passes with 0 live tests; there is no real-model evidence
   (Track E).
2. **D8:** the intermittent `write EPIPE` in the Track C upload test (test stability).
3. **D9:** the vulnerabilities reported by the throwaway Playwright install in CI (1 moderate, 4 high).
4. **D10:** CI database and disk headroom. Symptoms: the F1 write-storm failures in runs 46 and 52 (test fixed); the
   connection peak of 92 of 100 measured in Track A.
5. **Production readiness:** deployment, an operational restore and recovery drill on the target infrastructure, and
   monitoring and alerting. No AWS provisioning is authorized.
6. **Earlier pre-launch requirements still apply:**
   * Turnstile go-live (widget and secret, plus one live check);
   * legal review of the privacy policy;
   * the hard-ceiling proposal after 14 days of traffic.

**Accepted risks carried into `main` (owner decisions of 2026-11-09):**
* Uncertain provider outcomes, including HTTP 4xx/5xx, are charged. During a provider outage, failed calls consume
  users' daily AI quota.
* Track A refusal-stat writes share the database pool with signups. Accepted temporarily; isolation is a later
  workstream.

**Residual:**
* F9: live writes wait during `migrate`, so the runbook write freeze is required.
* `PGSSLROOTCERT=system` needs libpq 16 or later.

---

## Phase 2.5 Track D-1, second review pass (2026-11-09), recorded before the merge (merged afterwards; see above)
* **Status.** The first review of `614c56b` was HOLD. The owner's decisions and evidence requests of 2026-11-09 are now
  implemented. Merge, D-2, deployment and production release are **not** authorized.
* **Evidence:** `docs/PHASE2_5_TRACK_D1.md` §13.

**Changes since `614c56b`.** Each behavioural change was made red-first; verification tests were mutation-checked.
* **R1, F10 JSON durability.** The attempt is persisted synchronously before the provider is called. If the write
  fails, the provider is not called and the reservation is refunded.
* **R2, F10 billing by recorded attempt outcomes** (migration `0006`).
  * **Owner decision:** provider HTTP 4xx/5xx is `uncertain` and charged, as conservative policy; it is not a claim
    that the provider billed.
  * **Refunds** happen only when the provider was provably not invoked, or a successful response reported 0 usage.
  * **One unit per reservation**, settled exactly once, including under concurrent attempts.
* **R3, F9 runbook.** A seven-step write freeze for every `migrate` run, re-runs included, with SQL checked on a real
  database.
* **R4, F11.** TLS-required restore and verify-restore are tested end to end, including a TLS downgrade at `psql`.
* **R5, Track A load.**
  * 60 s and 5 min sustained refusal floods, pool kept at 10.
  * With slow stat writes, signups p50 / p95 / p99 were 691 / 908 / 933 ms, all successful, against p50 2.4 s before
    the fix.
  * Pool wait p95 / p99 were 263 / 290 ms, with 0 errors.
* **R6, migration `0006`.** Tested on a real version-5 database.
  * Interruptions (lock timeout, process killed mid-`ALTER`) leave version 5; a re-run recovers.
  * Legacy rows are byte-identical; the previous release runs against version 6.
  * The previous release's JSON ledger files load.
* **F1 test precondition.** The original check could pass with no write overlapping the backup. It now requires at
  least 2 writes during a backup made long enough by padding. The restore assertions are unchanged.

**Local gate (`7e09960`, the final code commit; later commits are docs only):**
* D-1 tests (33): 33/33 three times on JSON and three times on PostgreSQL.
* Full JSON suite: 287 tests, 285 pass, 0 fail, 2 skipped.
* Full PostgreSQL suite: 287 tests, 278 pass, 0 fail, 9 skipped.
* Build passes.
* Browser E2E: see `docs/PHASE2_5_TRACK_D1.md` §13.9.

**CI:** see `docs/PHASE2_5_TRACK_D1.md` §13.10 for the final head.

### Risk register changes (second pass)
| Item | Before | After |
|---|---|---|
| F10 JSON crash window (start not durable for up to 1 s) | found in review | **fixed** (`4a93567`, pending merge) |
| F10 refund/charge decided by the start alone | owner: change | **fixed**: recorded attempt outcomes decide (`4e87cc0`) |
| F10 provider HTTP 4xx/5xx billing unknown | open question | **decided**: charged conservatively (`d19a521`). Accepted consequence: provider outages consume users' daily AI quota. |
| F9 runbook lacked freeze verification, exit and re-run rule | found in review | **fixed** (`20e870c`) |
| F11 restore / verify-restore not tested end to end under required TLS | found in review | **fixed** (`4fc90a4`) |
| Migration `0006` upgrade, interruption and rollback compatibility | new | **verified** (`378d028`, `9e9d00a`) |
| Track A shared pool under refusal floods | measured | **accepted temporarily** by the owner. Isolation is deferred to a later workstream; no batching. |
| F1 test could pass without concurrent writes | found by CI | **fixed** (`6db5dbd`, `7f345e2`, `7e09960`) |
| CI database and disk headroom | open | open (D-2); the F1 CI failure was one symptom |
| D8 EPIPE flake; D9 Playwright install vulnerabilities | open | open (D-2) |
| R-01 live Gemini validation | release blocker | release blocker (Track E) |

## Phase 2.5 Track D-1 (F8, F9, F10, F11, D6, D2, D7): first review, recorded before the merge (superseded in part by the second pass above)
* **Evidence:** `docs/PHASE2_5_TRACK_D1.md`. Base: `main` @ `6ee9c11` plus `14c1438`. Head: the commit after `a5a4093` (docs
  only). D-2 has not been started. Passing CI is not merge approval and not release approval.
* **Fixed, each red-first on `6ee9c11`:**
  * F8: ownership enforced inside the save; deleted projects are not resurrected.
  * F9: the migration counter rebuild is correct under live writes and bounded per statement.
  * F10: an AI reservation is refunded only if the model call provably never started.
  * F11: backups verify `ai_reservations` by count and content; every backup connection follows the TLS policy.
  * D6: guest tokens accept exactly one encoding.
* **Verified in the real container (CI run 44):**
  * D2: the restore guard refuses after a real SIGKILLed restore, the volume stays unchanged, and recovery works.
  * D7: no tini, Node or ffmpeg process survives `docker stop` or a SIGKILL to Node only.
* **Gate finding in merged Track A code:**
  * refusal stats were written fire-and-forget, so diagnostics could miss them;
  * the test is intermittent: it failed locally on `3aa217c` but passed in CI;
  * a deterministic red test reproduces it; fixed in `a7b083e`, in its own commit.
* **D2 CI history:**
  * runs 39 and 41–43 failed because the test fixture ran as the container's PID 1, which ignores a self-sent SIGKILL;
  * the cause was confirmed from a rename log; fixed in `a5a4093`.
* **Local gate (`419351d`; later commits are CI scripts and docs only):**
  * D-1 tests: 18/18 three times on JSON and three times on PostgreSQL;
  * full JSON suite: 272 tests, 270 pass, 0 fail, 2 skipped;
  * full PostgreSQL suite: 272 tests, 263 pass, 0 fail, 9 skipped;
  * build passes; E2E 2/2 on each backend.
* **CI run 44 (`a5a4093`):**
  * `test`: same totals as the local gate;
  * `docker`: migrations to version 5; smoke tests, D2 and D7 pass; 0 errors;
  * `live-llm`: 0 live tests.

### Risk register changes (D-1)
| Item | Before | After |
|---|---|---|
| F8 cross-user overwrite on concurrent create; resurrection on update-after-delete | open (P2) | **fixed** (pending merge) |
| F9 counter drift and statement timeout in the migration rebuild | open (P3; mitigated by runbook write freeze) | **fixed** (pending merge). New residual: live saves wait on the migration's row locks. The runbook write freeze still applies. |
| F10 abort charged / crash expiry refunded regardless of model-call state | open | **fixed** per owner decision. Accepted risk: an uncertain state is charged. |
| F11 `ai_reservations` unverified; backup connections bypass TLS (libpq `prefer`) | open | **fixed** (pending merge). Residual: `PGSSLROOTCERT=system` needs libpq 16 or later (image ships 17). |
| D6 malleable guest-token encodings | open (owner: reject) | **fixed** (pending merge); tamper test unchanged |
| D2 restore guard untested in a real container | open | **verified in CI** |
| D7 ffmpeg survival on Node termination | open | **verified in CI** (normal and forced) |
| Track A refusal stats recorded after the answer | not known | **found and fixed** in D-1 (pending merge). Residual: a refusal waits for its stat write. |
| D8 EPIPE in upload test helper | open | open (D-2) |
| D9 Playwright throwaway-install vulnerabilities | open | open (D-2) |
| CI database connection headroom (92 of 100) | open | open (not re-measured) |

## Phase 2.5 Track A (R-03): MERGED (PR #6 → `main` @ `6ee9c11`, 2026-11-03) and closed
* **Merged with owner approval** as merge commit `6ee9c11`. Its parents are the previous `main` (`80e02b5`) and the
  approved head (`ce4c5e2`), and its tree is identical to `ce4c5e2`. The merge was pinned to that head SHA.
  * The code was tested in CI run 36 on `ffa98c0` (code `a11cf5d`).
  * `ce4c5e2` is docs-only: its non-docs tree hash equals `ffa98c0`'s. The owner waived a CI run for it.
* **Owner decisions** (`docs/PHASE2_5_TRACK_A.md` §10):
  * hard ceiling off until 14 days of traffic exist; the 10 × p99 value comes back for approval;
  * network limits of 20/h per IP and 100/h per /24 and /48, 3/day per device, with halving;
  * shared-network refusals recorded separately;
  * privacy notice approved as a draft (legal review still required);
  * deviations accepted with conditions.
* **Post-merge CI, run 38 on `main` @ `6ee9c11`: green, every job's log read:**

| Job / step | Result (from the log) |
|---|---|
| `test`: checkout, install, typecheck | step conclusions `success`. The fetched log is capped at 5 000 lines and starts during the JSON suite, so these steps are evidenced by status only. |
| `test`: JSON suite | 254 tests, 252 pass, **0 fail**, 0 cancelled, 2 skipped |
| `test`: every server on PostgreSQL | 254 tests, 245 pass, **0 fail**, 0 cancelled, 9 skipped |
| `test`: Track A (A0–A8, A-verify, A-decisions, contract tests, CAPTCHA E2E) | 32 result lines, 0 failures |
| `test`: build; E2E | build passes; E2E JSON 2/2, PostgreSQL 2/2 |
| `test`: `bun audit --audit-level=high` | "No vulnerabilities found (checked 389 packages, 2 below --audit-level=high, 1 ignored)" |
| `test`: E2E step's throwaway Playwright install | npm prints "5 vulnerabilities (1 moderate, 4 high)". Track A risk 13; Track D. |
| `docker` (complete log, 2 240 lines, 0 errors) | migrations `0001`–`0004` applied (`"version":4`); 2-instance PostgreSQL and JSON smoke tests pass; production refuses without TRUST_PROXY, without DATABASE_URL and without TURNSTILE_SECRET (exit 1 each) |
| `live-llm` | **green badge with 0 live tests**: `# pass 0`, `# skipped 2`, "GEMINI_API_KEY not set … (NOT passed)". Not live validation. |

* **Skips:**
  * 2 live Gemini tests per backend ("GEMINI_API_KEY not set");
  * 7 JSON-only tests on PostgreSQL;
  * no Track A test.
* **R-03: fixed and merged.** It is not live until the owner creates a Turnstile widget and stores the secret.

### Release position after Tracks C, B and A (production release NOT approved)
| Track | State |
|---|---|
| C, memory protection (R-13) | merged (`53fc724`) |
| B, render queue and billing (R-04, F7) | merged (`80e02b5`) |
| A, guest registration protection (R-03) | merged (`6ee9c11`), closed |
| D, operational hardening | D-1 merged (`39f2000`); D-2 not authorized |
| E, live Gemini validation (R-01) | not started; needs authorization |

**Open release blockers and pre-launch requirements:**
1. **R-01 live Gemini validation.** CI's `live-llm` passes with 0 live tests; there is no real model evidence (Track E).
2. **Turnstile go-live:** the owner creates the widget and stores the secret; one live check against the real Cloudflare
   widget.
3. **Privacy policy:** legal review of the full policy (the Track A §8 draft is approved as a draft only).
4. **Deployment and recovery evidence:** production deployment, an operational restore and recovery drill on the target
   infrastructure. No AWS provisioning has been authorized.
5. **Track D follow-ups:**
   * guest-token tamper test (fix without weakening it) and evaluation of non-canonical encodings;
   * Docker-level check that stopping Node also stops ffmpeg;
   * the EPIPE test helper;
   * the Playwright throwaway-install vulnerabilities;
   * CI database connection headroom (peaks at 92 of 100).
6. **After 14 days of traffic:** the hard-ceiling proposal for approval and a review of the guest network limits.

## Phase 2.5 Track B (R-04, F7): MERGED (PR #5 → `main` @ `80e02b5`, 2026-11-03)
* **Merged with owner approval** as merge commit `80e02b5`. Its parents are the previous `main` (`53fc724`) and the
  approved head (`63de0c5`), and its tree is identical to `63de0c5`. The merge was pinned to that head SHA.
* **Owner decisions approved:**
  * no reservation ledger: charge only on success, atomically with completion;
  * migration `0003`;
  * least-recently-served fairness;
  * per-instance `MAX_CONCURRENT_RENDERS` (aggregate = instances × limit);
  * every render goes through the queue.
* **Accepted evidence (`docs/PHASE2_5_TRACK_B.md`):**
  * Red first: 12 of 14 tests failed on the old code (F7 reproduced).
  * PostgreSQL completion and charge are one transaction: charge-failure injection, and SIGKILL inside the transaction
    rolls back as a unit, then recovery charges exactly once.
  * No double charge: stale worker, retried completion, 10 concurrent completions.
  * Failed, cancelled, expired and timed-out jobs are never charged.
  * JSON reconciliation is durable and idempotent: crash while completing, crash during reconciliation, repeated
    restarts, monthly reset.
  * Fairness: 3 × 3 round-robin.
  * No render path bypasses the queue.
  * Migration upgrade path v2 → v3, and the previous release runs on the v3 schema.
  * The run 28 failure (test premise) and its test-only fix are preserved.
* **Post-merge CI, run 34 on `main` @ `80e02b5`: green, every job's log read:**

| Job / step | Result (from the log) |
|---|---|
| `test`: typecheck, build | pass |
| `test`: JSON suite | 228 tests, 226 pass, 0 fail, 0 cancelled, 2 skipped (live Gemini) |
| `test`: every server on PostgreSQL | 228 tests, 219 pass, 0 fail, 0 cancelled, 9 skipped (2 live Gemini + 7 JSON-only) |
| `test`: Track B billing/queue/recovery, migration and guest-token tests | 52 result lines, all `ok` |
| `test`: E2E | JSON 1/1, PostgreSQL 1/1 |
| `test`: `bun audit --audit-level=high` | "No vulnerabilities found" |
| `docker` | images build; container applies `0001`–`0003` (`"version":3`); 2-instance PostgreSQL smoke; JSON smoke; unsafe config refused; backup tools present; 0 errors |
| `live-llm` | **green badge with 0 live tests**: `# pass 0`, `# skipped 2`, "GEMINI_API_KEY not set … (NOT passed)". This is the same CI-reporting finding as run 27, **not** live validation. |

* **Carried forward to Track D (owner, 2026-11-03):**
  1. Fix the guest-token tamper test so the tamper always changes the decoded signature bytes. **Do not remove or
     weaken the security test.**
  2. Separately, evaluate rejecting alternative (non-canonical) encodings of the same token.
  3. Test at Docker level that terminating Node also terminates its ffmpeg children (the `tini` / PID-namespace
     claim is unverified).
  4. The EPIPE exit-criterion test helper, from Track C.
  5. The npm warning in the E2E step's throwaway install ("5 vulnerabilities"); the gating `bun audit` passes.
* **Track B residual risks (accepted):**
  * the JSON backend under-counts usage until restart;
  * billing uses the requested duration;
  * fair-claim scale is proven only to the tested load;
  * sync wait vs. load balancer idle timeout;
  * shutdowns longer than 10 s fall back to the reaper.
* **Project position:**

| Track | State |
|---|---|
| C (memory protection) | merged |
| B (render queue and billing) | merged |
| A (guest protection) | not started, next |
| D (operational hardening) | not started |
| E (live Gemini) | not started |

* **Production release: NOT approved.** R-01 live Gemini is still a release blocker, and deployment readiness and
  operational recovery evidence are still missing.

## Phase 2.5 Track C (R-13): MERGED (PR #4 → `main` @ `53fc724`, 2026-11-02)
* **Merged with owner approval** as merge commit `53fc724`, whose parents are the previous `main` (`be4c48e`) and the
  approved head (`b895cfc`). `main` is byte-identical to `b895cfc`.
* **CI:**
  * PR run 26 on `b895cfc` and post-merge run 27 on `main` were both green, with logs inspected;
  * JSON suite 192/190/0/2, PostgreSQL suite 192/183/0/9;
  * E2E on both backends, build, audit and Docker all passed.
* **Accepted evidence:**
  * Bodies are read only after authentication.
  * Route-specific limits.
  * Bounded large bodies in flight: `503 busy` + `Retry-After`.
  * A memory guard with an ffmpeg-aware budget, `L = 0.8 x M - R x S` (1 GB with 2 renders → 307 MB). Invalid or
    insufficient budgets stop the server.
  * Slow-client timeouts.
  * Exit criterion: +15 to 18 MB RSS instead of +102 MB.
  * **Real** memory recovery: e.g. 571 → 114 MB, with readiness back only below 90 %.
* **Accepted residual risks** (recorded, not solved):
  1. The 256 MB per-render ffmpeg reserve is a planning allowance, **not a hard per-process memory cap**.
  2. Retention of long-lived **JavaScript heap objects is not measured**. Only Buffer memory was shown to be released.
  3. **No automatic client retry** on 503 `busy` / `memory_pressure` (`Retry-After` is always sent). Follow-up.
  4. **Dropped-socket failures** (R-13 note) remain **unexplained and unreproduced** (13 bursts).
  5. **No Docker-level test of Track C** (Track D).
  6. **Live Gemini validation is still skipped**; R-01 remains a release blocker.
* **Test-stability follow-up (Track D):**
  * the exit-criterion test helper can record `EPIPE` instead of a 413 under heavy local load (seen 2 times in
    about 20 runs, never in CI);
  * the server side was ruled out (1,600 controlled uploads all got their 413);
  * the helper must eventually tell genuine server failures apart from client socket timing, without suppressing
    errors.
* **CI-reporting finding (for Track E):**
  * on pushes to `main` the `live-llm` job **shows a green check while running zero live tests** (`# pass 0`,
    `# skipped 2`, "GEMINI_API_KEY not set … (NOT passed)", seen in run 27);
  * the badge must not be read as live validation;
  * Track E should make the job fail, or not run, when the key is absent.

## Integration (2026-11-02): PR #2 merged; PR #3 retargeted to `main`; awaiting final PR #3 decision
* **PR #2:**
  * J1 fixed red-first (the JSON restore is all-or-nothing, and the server and a restore can never overlap);
  * merged with your approval as merge commit **`5f19c99`**;
  * `main` is byte-identical to the approved `5cb211b`, and CI on `main` passed.
* **PR #3:**
  * integrated with merge commit `118b309`;
  * the J1 guard was moved to the start of `initStorage()`'s JSON branch, before any JSON data is opened;
  * an invariant test was added in `94e80d5` and shown non-vacuous;
  * F1–F6 files are byte-identical to the approved head;
  * CI runs 21 and 22 on `94e80d5` are green in every job.

  Details: PR3_REVIEW_PACKAGE §13.
* **Open findings and blockers, unchanged:**
  * **R-01**: live Gemini → MP4 not demonstrated; `live-llm` skipped in every run;
  * **R-03 / R-04 / R-13**: Phase 2.5;
  * **J2**: the cross-file consistency of a CLI snapshot taken while the server runs is open;
  * **F4**: backup authenticity;
  * **F7**: render billing;
  * **R-05/06/07/08/09/18**: product and legal issues;
  * **R-10**: no AWS environment, CD, monitoring or PITR test.
* **CI coverage gap:** the Docker job does not exercise the J1 guard on the built image (the `test` job does, from
  source).
* **Score: 58/100 (provisional). NOT READY FOR RELEASE.**

## Corrective round 2 (2026-11-02): F1, F2, F3, F5, F6 fixed in PR #3; CI green; awaiting your review
* **Fixed, red-first, with follow-ups from your evidence review:**
  * F1: snapshot-consistent manifest, plus a proof that the counts and `pg_dump` read the same exported snapshot;
  * F2: all-or-nothing restore; also F2a and F2b, plus the exact state at the COMMIT boundary and the read-only
    `verify-restore` operator check;
  * F3: restore target never in argv; the scan of every process and of all CLI output is clean;
  * F5: the previous release runs against a newer, validated backward-compatible schema;
  * F6: misnamed or duplicate migrations and unknown directives are errors.

  Evidence: PR3_REVIEW_PACKAGE §11–§12.
* **Local gate:** typecheck ✅; JSON 159/157/0/2; PostgreSQL 159/150/0/9; new regression tests 3× 37/37; E2E 1/1 on
  both backends; build ✅.
* **CI on `9f4d4d8`** ([run 41445535285](https://github.com/F-K75/viblo_shorts/actions/runs/41445535285)), with logs
  inspected:
  * `test` green (same counts as local);
  * `docker` green (two-instance smoke test, gated diagnostics, unsafe configs refused, backup image);
  * `live-llm` skipped (no key, not a pass).
* **Open release blockers:**
  * **R-01**: real Gemini → render → preview → playable MP4 export, P0;
  * **R-03/R-04/R-13**: Phase 2.5;
  * **R-05/06/07/08/09/18**: Phase 3/4;
  * **R-10**: no AWS environment, CD, monitoring or PITR test;
  * **F4**: backup authenticity;
  * **F7**: render billing.
* **Disclosed limitation (keep visible):** the backward-compatible migration allow-list checks statement types, not
  semantic effects. Manual review of every marked migration's data effect, backfills in particular, is mandatory
  (ADR-002).
* **Score: 55 → 58 (provisional).** The data layer's backup and restore path is now verifiable and atomic. The
  product is still **NOT READY FOR RELEASE**.

## PR #3 code review (2026-11-01)
The diff review (docs/PR3_CODE_REVIEW.md) found 2 P1 defects in backup/restore, both reproduced:
* F1: manifest row counts were not taken from the dump's snapshot, so every restore under traffic reported
  `verified:false`;
* F2: a failed restore stage committed a partial restore.

It also found these P2 findings:
* F3: target URL in argv;
* F4: backup authenticity;
* F5: old builds refuse a newer schema, which blocks rollback.

Phase 2.5 design is approved with conditions (PHASE2_5_PLAN §7); it is not implemented.

## Corrective round (2026-11-01): R-02, R-11, R-12, R-14 fixed in PR #3 — awaiting your review

**Status: FORGE STUDIO RELEASE READINESS SCORE: 55/100 (re-audit: 51) — NOT READY FOR RELEASE.**
Readiness is tracked by milestone, not by the score (see the scorecard below). Nothing was merged or deployed.

### What was fixed (one commit each, branch `claude/keen-feynman-xtbvz2-phase2`)
| ID | Commit | Root cause → fix | Evidence |
|---|---|---|---|
| **R-02** (P1) quota deadlock + lost refunds | `101b073` | Reserve locked `user:`→`ip:`; refund updated both via `key = ANY(…)` (scan order) → lock cycle. **Transaction redesign:** one global lock order (own reservation row → counters ascending by key) on reserve, settle and expiry; an `ai_reservations` ledger (migration 0002) makes reserve idempotent per id (no double charge) and settle a conditional `reserved→committed\|refunded` transition (no double refund); never-settled reservations are refunded by expiry (no permanent charge for failures); `withTx` retries `40P01`/`40001` safely as a backstop (residual → 503, not 500) | **Red first:** a 2-instance HTTP storm (80 concurrent fallbacks behind one IP) gave 500s and 503s on the old code. **Green:** 3/3 runs, 0 errors, every reservation refunded; mixed real/fallback storm charges exactly the 30 model calls; 200-cycle repo storm with exact counters; a real `40P01` produced and retried (asserted non-vacuously); idempotency + expiry contract tests on both backends. Original reproduction 45/45 × 200 (was 3 deadlocks). Load test: `generate-script` 15 × 200, p95 147 ms (was 2 × 500, p95 5,074 ms) |
| **R-11** (P2) DB password in argv | `7489fad` | `pg_dump`/`psql` got `--dbname <URL>`. Connection now passed as libpq env (`PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGSSL*`), URL percent-decoded, unknown params rejected | Wrappers around the real binaries record every argv during a full encrypted backup + restore with a password-bearing URL: no password or URL in any argv; password delivered via env; restore verified. *Red evidence is the old source (`'--dbname', url`); the new test cannot run against the old module (new export)* |
| **R-12** (P2) health disclosure + DB-per-request + unthrottled | `3be15b1` | `/api/health` + `/api/live` = liveness `{"status":"ok"}` (no deps); `/api/ready` cached with a single in-flight check; `/api/health/details` behind `HEALTH_DETAILS_TOKEN` (≥ 32 chars, constant-time) or an admin, 404 otherwise; `/api/config` feature flags only; in-memory per-IP throttling (no DB load) | Probe re-run: health flood **1,387/2,000 throttled** (was 0); public disclosure **`{}`** (was hostname, pool, guest counter, memory); a 300-request ready flood → ≤ 2 real checks; details 404 without/with a wrong token and for a normal user. CI asserts details are not public |
| **R-14** (P3) migrations under the request timeout | `10c4485` | Migration-specific `statement_timeout` (30 min) + client query timeout; bounded advisory-lock wait; `lock_timeout` (60 s) for DDL; all pending migrations in one never-retried transaction; non-transactional statements rejected up front | **Red 0/4 → green 4/4:** 3 s migration under a 500 ms request pool succeeds; a timeout leaves the schema unchanged and a re-run recovers; a busy table fails fast on lock timeout with nothing left behind; `CONCURRENTLY` rejected before anything is applied |

### Validation gate (executed this session; standard: docs/VALIDATION_STANDARD.md)
| Layer | Result |
|---|---|
| Typecheck / build | ✅ / ✅ |
| Unit + integration, JSON backend (`REQUIRE_PG_TESTS=1`) | **122 tests: 120 pass, 0 fail, 2 skipped** (live Gemini; no key) |
| Same suite, every server on PostgreSQL | **122 tests: 113 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific, each with a stated reason) |
| Concurrency (new `tests/concurrency.test.ts` + repo storms) | ✅ 3 consecutive green runs |
| Failure injection (DB outage, mid-transaction loss, migration timeout / lock timeout, crash-before-settle via expiry) | ✅ |
| Security / abuse probes re-run | R-12 fixed; **R-03 and R-04 still reproduce** (out of this round's scope; proposal written) |
| Browser E2E (JSON, PostgreSQL) | 1/1, 1/1 |
| Load test (PostgreSQL) | 0 × 5xx; p95: health 31 ms, save 235 ms, list 203 ms, generate-script 147 ms |
| Regression of every earlier finding | ✅ covered by the suites above |
| CI on the PR head | ✅ **green on `34b2501`** ([run 41339748515](https://github.com/F-K75/viblo_shorts/actions/runs/41339748515)), logs read. `test`: `pg_dump` 18.6 vs server 16, JSON 122/120/0/2, PostgreSQL 122/113/0/9 (identical to local); the R-02, R-11, R-12 and R-14 suites pass on both; E2E 1/1 on both. `docker`: two instances apply migrations 0001+0002 once, diagnostics 404 without the token and `{"status":"ok"}` public liveness asserted, unsafe configs refused. The first CI run of this round (`1524c44`) failed one **test** of mine: a throttle bound that ignored token-bucket refill (201 vs ≤ 200 allowed; throttle working, 99 × 429). Fixed in `34b2501` with the exact allowance, 5/5 local re-runs green |
| `bun audit` | unchanged: 3 known advisories (FS-022) |

### Still open — explicitly tracked release blockers
| Blocker | Status |
|---|---|
| **Real Gemini generation never demonstrated** (non-negotiable: real API call → render → preview → export) | ❌ open: needs a `GEMINI_API_KEY` |
| R-03 guest sign-up / guest pool DoS | ❌ open: proposal **approved**; implementation plan `docs/PHASE2_5_PLAN.md` §1 awaiting approval (Phase 2.5 PR after PR #3 merges) |
| R-04 render queue flooding | ❌ open: approved; plan §2 (no guest server renders, fair queue, global cap) |
| R-13 upload memory pressure (and 1–6 unexplained dropped sockets) | ✅ Track C merged (`53fc724`, `docs/PHASE2_5_TRACK_C.md`) with accepted residual risks; dropped-socket note still open; upload system out of scope |
| Fake password reset (R-05) | ❌ open: Phase 3 |
| Google Drive identity switching (R-06) | ❌ open: Phase 3 |
| Guest project ownership / migration on sign-up (R-07) | ❌ open: Phase 3 |
| Drive "video" export uploads no video (R-18) | ❌ open: Phase 3 |
| Payments unimplemented while paid plans are advertised (R-08) | ❌ open: decided "hide paid plans"; Phase 3 |
| Privacy policy, terms, account deletion (R-09) | ❌ open: Phase 4 |
| Production monitoring, alerting, deployment pipeline (R-10) | ❌ open: Phase 4 |
| Managed DB provider, KMS-encrypted off-site backups, measured RPO 15 min / RTO 4 h | ⏳ proposal: `docs/DATABASE_PROVIDER_COMPARISON.md` (needs the hosting-platform decision) |

### Milestone scorecard
| Milestone | Required outcome | Status |
|---|---|---|
| Phase 1 | Storage safety and data integrity | ✅ implemented, CI green, PR #2 awaiting review |
| Phase 2 | Durable PostgreSQL architecture | ✅ implemented + corrective round (this section); **pending your review**; provider not provisioned |
| Phase 2.5 | Abuse protection and concurrency | 🟡 concurrency hardened (R-02); abuse controls proposed, not implemented |
| Phase 3 | Functional AI product and user journeys | ⬜ not started (real Gemini still unverified) |
| Phase 4 | Security, compliance and operations | ⬜ not started |
| Phase 5 | Production deployment and verification | ⬜ not started |

### Process change
`docs/VALIDATION_STANDARD.md` now defines the mandatory gate layers: real DB, a concurrency matrix of every writer
pair, failure injection, free-tier abuse scenarios, red-before-green, non-vacuous assertions, and an independent
re-audit before merging storage/auth/limit changes. The Phase 2 gate missed R-02 because it tested the
scenarios its author imagined rather than every pair of writers to a shared row.

### Score movement (51 → 55)
Data reliability 10 → 11 (quota integrity under concurrency), Security 12 → 13 (credentials out of argv,
diagnostics gated), Testing 7 → 8 (concurrency matrix and failure injection), Performance 6 → 7 (no deadlocks; AI
p95 5.1 s → 0.15 s under load). Core functionality, Infra/ops and Product/legal are unchanged.

---

# Part R — Independent re-audit (discovery restart, unchanged below)


**Date:** 2026-11-01 · **Code audited:** `13e54e5` (head of `claude/keen-feynman-xtbvz2-phase2`, which contains Phase 1) —
the code that would ship. `main` (`98cdc30`) is the original baseline. **Mode:** discovery only. No code,
configuration, data or infrastructure was changed, and neither PR was modified.

**Method.** Earlier assessments were treated as claims, not evidence. Every result below comes from code I read or
a command I ran in this session against real processes: a local PostgreSQL 16.15, the production build, and
headless Chromium. All probes were scripts in `/tmp` against throwaway servers and databases.

## FORGE STUDIO RELEASE READINESS SCORE: **51/100**

## Verdict: **NOT READY FOR RELEASE**

Why this is lower than the 64 reported at the end of Phase 2: the re-audit found **new defects that the
Phase 2 gate missed**. The worst are a PostgreSQL deadlock that loses quota refunds and returns 500s, and cheap
denial-of-service paths against guest onboarding and the render queue. An earlier claim ("the code cannot
deadlock", ADR-003) is **false**. The previous score over-credited security and data integrity.

---

## 1. Executive summary

**What is genuinely solid (verified this session):**
* Server-verified authentication, owner-only authorization and 404-on-foreign-ids. Abuse limits hold per user,
  per IP and across instances.
* Transactional PostgreSQL storage with exact per-user quotas. A verified, idempotent JSON → PostgreSQL migration
  with dry run and rollback. Encrypted off-site backups whose restore was proven, including across `pg_dump`
  versions in CI.
* Reproducible build, a large real test suite (below), and the prompt → script → save → export journey working in a
  real browser on PostgreSQL.

**Release blockers (highest risk first):**
1. **R-01 (P0, unchanged since discovery):** the core AI has **never been observed working**. Both live tests
   skip; CI's live job only runs on `main`, without a key.
2. **R-02 (P1, NEW):** PostgreSQL **deadlocks** under concurrent AI requests from one network → HTTP 500s and
   **lost quota refunds** (users charged for template fallbacks again). Reproduced: 3/45 requests.
3. **R-03 (P1, NEW, introduced by the Phase 1 fix):** the global guest sign-up budget can be **exhausted in
   ~2 s**, locking every new visitor out of guest mode for an hour. The guest storage pool fills in ~32 s.
4. **R-04 (P1, NEW):** free guests can queue **500 one-minute 1080p renders in 1.5 s**; real users' jobs starve
   and instance CPU stays saturated.
5. **R-05 – R-09 (P1, unchanged since discovery, frontend untouched):** fake "Forgot password", Drive sign-in
   silently switches the account, guest work orphaned on sign-up/sign-in/sign-out, paid plans and "Encrypted cloud
   checkout" advertised with no payment system, no privacy policy/terms/account deletion.
6. **R-10 (P1):** no production infrastructure exists yet: no provider, HA, PITR, bucket, CD, staging,
   monitoring or alerting.

## 2. Evidence base (executed in this session)

| Check | Result |
|---|---|
| `npm run lint` (frontend + server + scripts) / `npm run build` | exit 0 / exit 0 (main chunk 451 KB) |
| `npm test`, JSON backend, `REQUIRE_PG_TESTS=1` | **110 tests: 108 pass, 0 fail, 2 skipped** (live Gemini, no key) |
| `npm test`, every server on PostgreSQL | **110 tests: 101 pass, 0 fail, 9 skipped** (2 live Gemini + 7 JSON-file-specific, each with a stated reason) |
| Browser E2E on production build, PostgreSQL | 1/1 pass |
| Load test, PostgreSQL, 20 concurrent clients | health p50 20.7 / p95 43.3 ms; save p50 120 / p95 225 ms; list p50 61 / p95 184 ms; **generate-script: 2 × HTTP 500, p95 5,074 ms** |
| `bun audit` | 3 advisories (1 high via firebase→firestore→grpc-js, not imported; vite moderate; low) |
| CI (GitHub) on `13e54e5` | test + docker green ([run 41320121004](https://github.com/F-K75/viblo_shorts/actions/runs/41320121004)); `live-llm` **skipped** |
| Frontend diff since baseline | **0 changed files** in `src/` and `index.html` |
| Probes (this audit) | deadlock reproduction; guest-mint and guest-pool exhaustion; unauthenticated health flood; health disclosure; render-queue starvation (results in §4) |

**Not verifiable here:** real Gemini, YouTube, Pexels, Firebase sign-in, Google Drive, remote media CORS, a
managed PostgreSQL provider's HA/PITR, real S3 (an S3-API stub was used), or production-sized restore times.
None of these are counted as working.

## 3. Architecture (as built)

React 19 SPA (unchanged since baseline) → Express 4 (`server.ts`, ~2.5k lines, run by `tsx`) → `Repo` interface
with a **PostgreSQL** implementation (production; transactional; rate limits, quotas, render queue and guest
budget shared across instances) and a **JSON** implementation (development and rollback; single instance).
Gemini via `@google/genai` (template fallbacks), YouTube oEmbed plus caption scraping, Pexels, and ffmpeg
renders on the instance's own disk. Off-site backups use `pg_dump | age` → S3-compatible storage
(`Dockerfile.backup`). CI: typecheck, both backends, E2E, audit gate, and a Docker smoke test with two instances
on one database.

## 4. Findings

Severity: **P0** = blocks any public exposure · **P1** = blocks GA · **P2** = fix before scale · **P3** = hygiene.

### NEW in this re-audit

**R-02 · P1 · PostgreSQL deadlock between AI quota reservation and refund** — `server/db/pgRepo.ts`
(`reserveAi`, `refundAi`), `server.ts` (`rateLimit`)
* *Problem:* `reserveAi` locks `ai_usage_daily` rows in order `user:<id>` → `ip:<addr>`. `refundAi` runs one
  `UPDATE … WHERE key = ANY(…)`, which locks the same two rows in scan order (often `ip:` first). Two concurrent
  requests sharing an IP can each hold one row and wait for the other.
* *Evidence:* 15 concurrent `generate-script` calls from 5 guests on one IP, run 3 times → `error: deadlock
  detected` (HTTP 500) in 3/45 requests and `{"event":"ai_refund_failed","error":"deadlock detected"}`. The load
  test reproduced it independently (2 × 500).
* *Business impact:* users behind one NAT, office or mobile carrier see random 500s on AI actions **and are charged
  quota for failed/template calls**. That is the FS-007 guarantee broken again, but only on PostgreSQL.
* *Technical impact:* aborted transactions; the refund is not retried; quota counters drift upward.
* *Fix:* take rows in one deterministic order on both paths: refund with per-key UPDATEs in the same order as
  reserve (or `SELECT … ORDER BY key FOR UPDATE` first). Retry a transaction once on SQLSTATE `40P01`/`40001`;
  map an exhausted retry to 503, not 500.
* *Validation:* a concurrency test with ≥ 50 concurrent fallback AI calls from one IP across 2 instances ⇒ 0 × 500,
  0 `ai_refund_failed`, and `dailyQuotaUsed` = 0 afterwards; the load test shows no 500s.

**R-03 · P1 · Guest onboarding denial of service (global sign-up budget, guest storage pool)** — `server.ts`
(`guestMintBudget`), `server/db/pgRepo.ts` (guest pool)
* *Problem:* the global budget (`GUEST_MINT_PER_HOUR=1000`) is first-come-first-served. The 512 MB guest pool is
  shared by all guests with no expiry (FS-034).
* *Evidence:* 1,000 guests minted from 1,000 IPs in **2,042 ms**; a new visitor then got `429 guest_capacity`.
  From only 2 IPs at the per-IP limit it takes ~50 min. Those guests filled the pool (1,037 × 500 KB) in **32 s**;
  after that only saves smaller than the remaining headroom succeed. Signed-in users were unaffected.
* *Impact:* the "Explore as Guest" funnel, the main conversion path, can be switched off by anyone for an hour at
  a time.
* *Fix:* CAPTCHA/App Check on guest mint; per-/24 (IPv4) and per-/48 (IPv6) budgets instead of one global
  counter; guest retention/expiry (approve the retention proposal) so the pool frees itself; alerting on budget
  exhaustion; optionally keep a reserved share of the budget for traffic that passes the CAPTCHA.
* *Validation:* the same probe cannot block a fresh visitor who passes the CAPTCHA; pool usage drops after
  expiry runs.

**R-04 · P1 · Render queue starvation / CPU exhaustion by free guests** — `server.ts` (`/api/jobs/create`,
worker), `server/db/pgRepo.ts` (`claimNextJob`)
* *Problem:* any guest may queue 5 × 60 s 1080p renders (10 free render-minutes each). Guests are free to mint, and
  the queue is global FIFO with no fairness or priority.
* *Evidence:* 100 guests queued **500 jobs in 1,555 ms**; a signed-in user's 10 s job was still `queued` after
  20 s with both render slots busy.
* *Impact:* server renders unusable for real users, and render CPU steals capacity from web requests on the same
  instance. The UI does not use server renders today, but the endpoint is public.
* *Fix:* disable server rendering for guests (or behind a feature flag until the UI uses it); per-user fair
  queueing (round-robin by user); a global queued-job cap with 503; run renders on separate worker instances
  (Phase 4, with FS-037).
* *Validation:* the probe cannot delay a signed-in user's job by more than one render slot.

**R-11 · P2 · Database credentials on the command line** — `server/db/offsiteBackup.ts` (`pg_dump`, `psql`
spawned with `--dbname <DATABASE_URL>`)
* *Problem:* the full URL, including the password, appears in the process arguments, which are readable via
  `/proc/<pid>/cmdline` / `ps` by other processes on the host or in the container.
* *Fix:* pass host/port/db/user as arguments and the password via `PGPASSWORD` in the child's environment (or a
  0600 `.pgpass`); never include the password in argv.
* *Validation:* while a backup runs, `ps -o args` shows no password.

**R-12 · P2 · Unauthenticated, unthrottled endpoints that hit the database and disclose internals** —
`server.ts` (`/api/health`, `/api/ready`)
* *Evidence:* 2,000 concurrent anonymous `/api/health` calls → 2,000 × 200, 0 throttled, each running a DB query.
  The response exposes hostname:pid, DB pool counts, the guest-mint counter (lets an attacker watch R-03 progress),
  proxy configuration and memory.
* *Fix:* public liveness returns `{status}` only; detailed health behind an internal port or token; rate-limit both
  or cache the DB check for ~1 s.
* *Validation:* an anonymous `/api/health` returns no internals; a flood is throttled or does not reach the DB per
  request.

**R-13 · P2 · Memory pressure from concurrent large request bodies** — `server.ts` (`express.json({limit:'1mb'})`)
* *Evidence:* ~250 concurrent 500 KB uploads → heap ~308 MB used, RSS 443 MB, and 6 of 1,054 uploads saw dropped
  connections (`UND_ERR_SOCKET`). The server stayed up. **The dropped connections were not root-caused.**
* *Impact:* with the 1 GB container limit, a larger burst of ~1 MB bodies could OOM-kill an instance.
* *Fix:* cap concurrent body-parsing requests (or a lower body limit for non-project routes); measure with a
  1,000-concurrent 1 MB test; investigate the socket resets.
* *Validation:* a 1,000 × 1 MB burst leaves the process alive with bounded RSS.

**R-14 · P3 · Migrations run under the 10 s statement timeout** — `server/db/pool.ts`, `server/db/migrate.ts`
* *Problem:* a future migration on a large table (index build, backfill) will be cancelled mid-way at startup.
* *Fix:* `SET LOCAL statement_timeout = 0` (or a migration-specific value) inside the migration transaction; run
  heavy migrations as a release step.

**R-15 · P3 · Latency on PostgreSQL is 2–3× the JSON backend under load** — measured locally on one machine with
DB and app co-located: save p50 120 ms (JSON ~59 ms), list p50 61 ms (JSON ~19 ms) at 20 concurrency.
Acceptable now; re-measure against the real provider (network RTT adds per query) and reduce round-trips per
request (rate limit + quota + write are separate transactions).

### Still open from discovery (re-verified in current code)
| ID | Sev | Issue | Re-verification |
|---|---|---|---|
| R-01 (FS-003) | **P0** | Real Gemini never observed; model ids unverified | live tests skipped; CI `live-llm` skipped on PRs |
| R-05 (FS-004) | P1 | "Forgot password" shows a success message, sends nothing | `AuthPage.tsx:329` |
| R-06 (FS-005) | P1 | Drive OAuth uses `signInWithPopup` on the shared Firebase auth → switches the app identity | `googleDrive.ts:52` |
| R-07 (FS-006) | P1 | Guest work orphaned on sign-up/sign-in/sign-out (no claim/migration) | 4 × `clearGuestSession()` |
| R-08 (FS-009) | P1 | $29/$79 plans + "Encrypted cloud checkout" advertised; no payment provider | `BillingModal.tsx:256,324,375` |
| R-09 (FS-014) | P1 | No privacy policy, terms, account deletion or data export | 0 matches in `src/` |
| R-10 (FS-011/012) | P1 | No CD, staging, monitoring, alerting, LLM cost ledger; no provisioned DB/bucket | — |
| R-16 (FS-010) | P1 | Headline "original voice and audio" from YouTube can't be delivered; captions via scraping (ToS) | approved direction (uploads + server compositing) not started |
| R-17 (FS-013) | P2 | No Content-Security-Policy; 30-day irrevocable guest token in `localStorage` | 0 matches for CSP |
| R-18 (FS-020) | P2 | Drive export claims video upload; only JSON + SRT uploaded | `videoBlob` declared, never used |
| R-19 (FS-025) | P2 | No email verification, no App Check; "Remember me" does nothing | no `setPersistence` |
| R-20 (FS-037) | P2 | Rendered MP4s on the rendering instance's disk (404 behind non-sticky LB) | ADR-007 |
| R-21 (FS-021) | P2 | Runtime image ships devDependencies; `tsx` at runtime; floating base tags | Dockerfile |
| R-22 (FS-022) | P2 | Dependency advisories (see §2) | `bun audit` |
| R-23 (FS-023) | P2 | No frontend unit/component tests; one happy-path E2E; concurrency on AI paths untested (this is how R-02 slipped) | test inventory |
| R-24 (FS-027) | P2 | Fallback templates contain unsourced health claims | `server.ts` templates |
| R-25 (FS-026/024) | P2 | Export real-time, foreground-only; remote media CORS unverified | — |
| R-26 | P3 | Monolithic `server.ts` / `App.tsx`; dead `YouTubeToClips.tsx`; 451 KB main chunk | — |

### Verified fixed (no longer findings)
Client-trusted identity and header-spoofable admin; path traversal; free self-upgrade of plans; foreign
jobs/projects access; storage amplification per user and cross-user latency (victim p95 stays ~7 ms with
27.7 MB of attacker data); whole-store loss on corruption; in-memory quotas lost on restart; proxy-spoofable rate
limits; job-retry limit bypass; async route crashes; crash on DB connection loss; restore across `pg_dump`
versions. All of these are reproduced by tests that ran green in this session.

## 5. Security summary
* **AuthN/AuthZ:** solid and tested (RS256 Firebase verification, HMAC guest tokens, owner checks, 404s).
  Weaknesses: the Drive identity switch (R-06), irrevocable 30-day guest tokens and no CSP (R-17), no email
  verification or App Check (R-19).
* **Abuse/availability:** per-user/IP limits hold, but the *free guest* tier is the soft spot: onboarding DoS
  (R-03), render-queue CPU abuse (R-04), unthrottled DB-touching health endpoints (R-12), memory pressure (R-13).
* **Secrets:** env-only and never logged; but DB credentials go into process argv during backups (R-11).
  Backups are encrypted with an offline private key.
* **Injection:** parameterized SQL throughout (the only interpolations are constant table names and test DB
  names); ffmpeg via argv; SSRF allowlist; prompt input tag-delimited and output schema-validated.

## 6. Testing gaps
The concurrency suite covers saves, reservations and job claims, but **not concurrent AI fallbacks/refunds on one
key**, which is how R-02 shipped through a green gate. Also missing: free-tier abuse tests (R-03/R-04),
frontend component tests, real-provider tests (Gemini, Firebase, Drive, YouTube), and load tests at production
scale against a remote database.

## 7. Performance / scalability
App tier scales horizontally, except render files (R-20). On PostgreSQL each AI request performs 3–4 separate
transactions (rate limit, subscription read, quota reserve, refund), so latency grows with DB round-trip time.
Deadlocks (R-02) appear at modest concurrency. The render CPU shares the web instances (R-04).

## 8. Score
| Dimension | Weight | Score | Rationale |
|---|---:|---:|---|
| Core functionality | 20 | 8 | Prompt → export works (E2E); AI never observed; YouTube headline undeliverable; Drive half-implemented; fake reset |
| Security | 20 | 12 | Strong authN/Z and limits; free-tier DoS paths, Drive identity switch, no CSP, credentials in argv |
| Data reliability | 15 | 10 | Transactions, verified migration, tested encrypted restore; deadlock-driven quota drift; no provider HA/PITR configured |
| Testing | 10 | 7 | Large, real, dual-backend suite; missed the AI concurrency deadlock; no frontend or live-provider tests |
| Infra / deploy / ops | 15 | 6 | Images and CI solid; no CD, staging, monitoring, provisioned DB/bucket |
| Performance / scale | 10 | 6 | Horizontal app tier; deadlocks under concurrency; per-instance renders; body memory pressure |
| Product / legal readiness | 10 | 2 | Fake reset, unpurchasable plans advertised, no legal pages, YouTube ToS exposure |
| **Total** | **100** | **51** | |

## FORGE STUDIO RELEASE READINESS SCORE: 51/100 — **NOT READY FOR RELEASE**

## 9. Recommended roadmap (adjusted by this re-audit)
1. **Phase 2.1 — correctness hotfix (before anything else; small, on the Phase 2 branch):** R-02 deadlock + retry,
   R-11 credentials out of argv, R-14 migration timeout, R-12 health hardening, plus a concurrency regression test
   for AI refunds.
2. **Phase 2.2 — free-tier abuse controls:** R-03 (CAPTCHA/App Check, per-subnet budgets, retention once
   approved) and R-04 (no guest renders, fair queue, global cap), R-13 body concurrency cap.
3. **Phase 3 — product correctness (as planned):** live Gemini validation + eval set (R-01), auth fixes
   (R-05/06/07/19), hide paid plans (R-08), Drive truthfulness (R-18), uploaded-source workflow (R-16), neutral
   templates (R-24).
4. **Phase 4 — operations:** provider + bucket provisioning with HA/PITR, CD + staging + rollback, monitoring and
   alerting (including guest-budget and deadlock alerts), CSP, object storage and separate render workers
   (R-20/R-04), image hardening.
5. **Phase 5 — certification:** legal pages and account deletion (R-09), frontend and live-provider tests,
   production-scale load and restore drills, security retest.

**Decisions needed:** whether to fold Phase 2.1 into PR #3 before review (recommended: it fixes a regression of a
Phase 1 guarantee), plus the five Phase 2 decisions already pending (provider, bucket and key custody, RPO/RTO,
guest retention, merge order).
