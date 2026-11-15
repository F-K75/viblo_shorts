---
name: AGENTS
role: Agent Registry
subagent: false
---

# Agent Registry (AGENTS.md)

This file lists all custom agents defined for the **Forge AI** multi‑agent engineering organisation. Each agent is defined in its own Markdown file under `.agents/agents/`.

| Agent | Description | File |
|-------|-------------|------|
| **orchestrator** | Lead Engineering Orchestrator – coordinates tasks, invokes subagents, manages approvals. | [.agents/agents/orchestrator.md](file:///Users/keshav/viblo_shorts/.agents/agents/orchestrator.md) |
| **architect** | System Architect – performs architecture assessments and produces documentation. | [.agents/agents/architect.md](file:///Users/keshav/viblo_shorts/.agents/agents/architect.md) |
| **backend‑engineer** | Backend Engineer – evaluates server code, APIs, DB interactions, and performance. | [.agents/agents/backend-engineer.md](file:///Users/keshav/viblo_shorts/.agents/agents/backend-engineer.md) |
| **frontend‑engineer** | Frontend Engineer – inspects React/Vite UI, component quality, and integration. | [.agents/agents/frontend-engineer.md](file:///Users/keshav/viblo_shorts/.agents/agents/frontend-engineer.md) |
| **ai‑engineer** | AI Engineer – audits LLM integration, usage tracking, and model orchestration. | [.agents/agents/ai-engineer.md](file:///Users/keshav/viblo_shorts/.agents/agents/ai-engineer.md) |
| **qa‑engineer** | QA Engineer – verifies test coverage, runs lint/unit/e2e suites, and proposes improvements. | [.agents/agents/qa-engineer.md](file:///Users/keshav/viblo_shorts/.agents/agents/qa-engineer.md) |
| **security‑engineer** | Security Engineer – conducts security audits, reviews policies, and ensures safeguards. | [.agents/agents/security-engineer.md](file:///Users/keshav/viblo_shorts/.agents/agents/security-engineer.md) |
| **devops‑engineer** | DevOps Engineer – assesses CI/CD pipelines, Docker/K8s configs, and infrastructure. | [.agents/agents/devops-engineer.md](file:///Users/keshav/viblo_shorts/.agents/agents/devops-engineer.md) |
| **independent‑reviewer** | Independent Reviewer – read‑only auditor that challenges findings before G4 approval. | [.agents/agents/independent-reviewer.md](file:///Users/keshav/viblo_shorts/.agents/agents/independent-reviewer.md) |

All agents have `subagent: true` where they may be invoked as independent sub‑agents. Permissions are defined within each agent file.
