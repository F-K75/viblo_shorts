---
name: TASK_BOARD
role: Engineering Task Board
subagent: false
---

# Task Board

This board tracks all engineering tasks across their lifecycle through Gate 5 (Merged).

| Task ID | Owner | Branch | Scope & Description | Test Evidence | Gate Status | State |
|---|---|---|---|---|:---:|:---:|
| **FMO-001** | `orchestrator` | Foundation | [Repository discovery](FMO-001_REPOSITORY_DISCOVERY.md) | Current main quality baseline: 12 pass / 12 fail with FFprobe absent | Discovery recorded | **COMPLETE** |
| **FMO-002** | `architect` | Foundation | [Existing Forge integration map](FMO_MEDIA_OS_FOUNDATION.md#fmo-002-integration-map) | Checked against main and prototype | Design recorded | **COMPLETE** |
| **FMO-003** | `architect` | Foundation | [Media OS architecture decisions](FMO_MEDIA_OS_FOUNDATION.md#fmo-003-architecture-decisions) | Depends on FMO-001–002 | Design recorded | **COMPLETE** |
| **FMO-004** | `backend-engineer` | Foundation | Runtime manifest and first-slice timeline contracts in `server/media/` | Registry and timeline tests; TypeScript check | Tested locally | **IMPLEMENTED** |
| **FMO-005** | `backend-engineer` | Foundation | Versioned registry, lifecycle, and dependency resolution in `registry.ts` | Registry tests cover availability, cycles, permissions, and resources | Tested locally | **IMPLEMENTED** |
| **FMO-006** | `backend-engineer` | Foundation | `npm run media:validate` and pilot under `media_skills/` | Pilot loads as `planned` | Tested locally | **IMPLEMENTED** |
| **FMO-007** | `backend-engineer` | Foundation | Typed provider interface in `provider.ts` | TypeScript check | Tested locally | **IMPLEMENTED** |
| **FMO-008** | `backend-engineer` | Foundation | FFmpeg/FFprobe readiness in `ffmpegReadiness.ts` | 5 readiness tests pass; real FFmpeg 7.1 present, FFprobe missing | Execution pending | **PARTIAL** |
| **FMO-009** | `devops-engineer` | — | Isolated CPU worker with restricted filesystem and network | Depends on typed provider execution and queue claim filters | Pending | **BACKLOG** |
| **FMO-010** | `backend-engineer` | — | Owner-scoped, immutable media assets and versioned artifacts | Needs storage, migration, and backup contract tests | Pending | **BACKLOG** |
| **FMO-011** | `backend-engineer` | — | Bind resolver to admission and worker dispatch | Depends on FMO-005 and FMO-008–010; authorization recheck required | Pending | **BACKLOG** |
| **FMO-012** | `orchestrator` | — | Five-clip Reel from brief through render and internal delivery | Depends on FMO-008–011 and artifact approval from FMO-013 | Pending | **BACKLOG** |
| **FMO-013** | `qa-engineer` | — | Independent 90/100 quality gate, persisted evidence and hard failures | Requires measured artifact validation with native FFmpeg/FFprobe | Pending | **BACKLOG** |
| **FMO-014** | `ai-engineer` | — | Evidence-driven revision planner with three-attempt limit | Depends on FMO-012–013 and budget accounting | Pending | **BACKLOG** |
| **FMO-015** | `frontend-engineer` | — | Media Studio workspace and owner-scoped workflow status | Depends on the workflow, artifact, and report APIs | Pending | **BACKLOG** |
| **TASK-001** | `frontend-engineer` | `fix/TASK-001-shorts-player-perf` | Eliminate message listener and video play re-render stutter | Verified in worktree | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-003** | `backend-engineer` | `fix/TASK-003-auth-csp-hardening` | Enforce strict Content-Security-Policy headers and verify email status | `tests/security.test.ts`, `tests/auth_llm_storage.test.ts` | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-004** | `frontend-engineer` | `fix/TASK-004-frontend-auth-drive` | Isolate Google Drive OAuth into secondary Firebase app and sync auth state | Component & auth tests | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-005** | `frontend-engineer` | `fix/TASK-005-api-checks-tts-leak` | Bound TTS blob cache (LRU max 50) and handle API error feedback | Memory & audio tests | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-006** | `devops-engineer` | `chore/TASK-006-ci-docker-pinning` | Separate prod-deps in Dockerfile and pin playwright dependency | Docker build & CI config | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-007** | `backend-engineer` | `feat/TASK-007-guest-project-claim` | Atomic guest project claim endpoint and dual-repo implementation | `tests/api.test.ts`, `tests/repo_contract.test.ts` | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-008** | `qa-engineer` | `chore/TASK-008-frontend-tests-lint` | Frontend component test harness and test lint script | `tests/components/*.test.ts` | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-009** | `backend-engineer` | `refactor/TASK-009-server-routes` | Modularize Express server routes into `server/routes/*` | Unit & API tests | G5 MERGED | **MERGED_INTO_MAIN** |
| **TASK-002** | `ai-engineer` | `feat/TASK-002-gemini-structured-output` | Native Gemini `responseSchema` migration | Requires live GEMINI_API_KEY | G2 PLAN | **PENDING_API_KEY** |

---

*Merged rows record Gate 5 approval for their individual tasks. Media OS release classification is `NOT_READY`.*
