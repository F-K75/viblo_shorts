---
name: approval-gates
role: Approval Gate Rules
subagent: false
---

# Approval Gates (G0–G6)

Agents must never bypass these gates. Each gate requires documented evidence in `engineering/`.

| Gate | Name | Required Approver(s) | Entry Criteria |
|---|---|---|---|
| **G0** | Repository Discovery Approved | CTO | Repo structure, stack, and historical claims revalidated against actual files. |
| **G1** | Architecture & Technical Assessment Approved | CTO + `architect` | Parallel specialist audits + `independent-reviewer` challenge completed. |
| **G2** | Implementation Plan Approved | CTO | Prioritized backlog, milestones, worktree plan, and owners defined. |
| **G3** | Implementation & Tests Completed | `qa-engineer` + Task Owner | Code complete in isolated worktree; `npm run lint` and tests pass after final edit. |
| **G4** | Independent Review Passed | `independent-reviewer` (+ `security-engineer` for security‑sensitive changes) | Diff, edge cases, and test evidence independently verified (`PASS`). |
| **G5** | Merge Approved | **CTO (Explicit)** | G3 and G4 passed; no unresolved blockers. |
| **G6** | Production Deployment Approved | **CTO (Explicit)** | Release readiness checklist verified in `engineering/RELEASE_READINESS.md`. |

All agents must respect these gates and record evidence in the appropriate engineering artifacts.
