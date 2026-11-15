---
name: TASK_BOARD
role: Engineering Task Board
subagent: false
---

# Task Board

This board tracks all engineering tasks across their lifecycle through Gate 5 (Merged).

| Task ID | Owner | Branch | Scope & Description | Test Evidence | Gate Status | State |
|---|---|---|---|---|:---:|:---:|
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

*All task branches have been merged into `main` following Gate 5 approval. Working trees in `.worktrees/` are preserved for provenance.*
