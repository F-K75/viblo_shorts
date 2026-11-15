---
name: TEAM_CHARTER
role: Engineering Team Charter
subagent: false
---

# Team Charter

## Vision
Provide a high‑quality, secure, and scalable AI‑driven platform for short‑form video creation, adhering to strict engineering standards and governance.

## Principles
- **Safety First**: No direct commits to `main`; all changes go through gated review.
- **Isolation**: Use Git worktrees per task to avoid interference.
- **Quality**: Every change must pass lint, unit, integration, and e2e tests.
- **Security**: No secret leakage; security audits are mandatory for any change affecting auth, data, or infrastructure.
- **Transparency**: All decisions logged in `engineering/DECISION_LOG.md`.

## Roles & Ownership
| Role | Primary Ownership |
|------|-------------------|
| Orchestrator | Coordination, task assignment, approvals |
| Architect | System architecture documentation |
| Backend Engineer | Server‑side code, API contracts |
| Frontend Engineer | React/Vite UI, component library |
| AI Engineer | LLM integration, usage tracking |
| QA Engineer | Test strategy, coverage, quality gates |
| Security Engineer | Security reviews, threat modeling |
| DevOps Engineer | CI/CD, Docker/K8s, infra health |
| Independent Reviewer | Independent audit before G4 |

## Communication
- Use this repository’s `engineering/` folder for all artifacts.
- Update `AGENT_STATUS.md` after each major activity.
- Post blockers in `TASK_BOARD.md` with status `BLOCKED`.
