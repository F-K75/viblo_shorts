# Forge Studio (`viblo_shorts`) — Decision Log

| ID | Date | Author | Status | Decision & Context |
|---|---|---|---|---|
| **DEC-001** | 2026-11-15 | `orchestrator` + `independent-reviewer` | **Confirmed** | **Revalidate & Reject Phantom Stack Claims**: Direct inspection confirmed `viblo_shorts` is a TypeScript/Express/React/PostgreSQL+JSON app (Forge Studio). Historical/external claims about `k8s/secrets.yaml`, `backend/core/ai_usage.py`, MongoDB, Redis runtime, Celery, WebSockets, and CI `continue-on-error` do not exist in this repository and are excluded from engineering scope. |
| **DEC-002** | 2026-11-15 | `orchestrator` | **Confirmed** | **Read-Only Audit Independence**: `security-engineer` and `independent-reviewer` are configured with read-only tools (`[read_file, search_web]`) in `.agents/agents/` to preserve G4 audit independence. |
| **DEC-003** | 2026-11-15 | `orchestrator` | **Confirmed** | **Non-Overlapping Worktree Schedule**: `server.ts` and `package.json` are high-contention files. Tasks touching `server.ts` (`TASK-002`, `TASK-003`, `TASK-007`, `TASK-009`) and `package.json` (`TASK-006`, `TASK-008`) are serialized on `engineering/TASK_BOARD.md`. |
| **DEC-004** | 2026-11-15 | `orchestrator` | **Proposed (G2)** | **Recommended First Milestone (M1 — Stabilization & Security Hardening)**: Execute `TASK-001` (`ShortsPlayer.tsx` P0 perf), `TASK-003` (`email_verified` + CSP), `TASK-005` (`res.ok` + TTS Blob leak), and `TASK-006` (Pin Playwright + Docker pruning) in parallel non-overlapping worktrees, followed by `TASK-002` once `GEMINI_API_KEY` is available. |
| **FMO-ADR-001–007** | 2026-11-25 | `orchestrator` | **Foundation design** | [Media OS architecture](FMO_MEDIA_OS_FOUNDATION.md#fmo-003-architecture-decisions) records the worker boundaries, manifest qualification, artifact and event durability, independent QA, and autonomous execution gates. |

