---
name: git-workflow
role: Git Workflow Rules
subagent: false
---

# Git Workflow & Worktree Isolation

1. **No Direct Commits to `main`**: All implementation work must happen on a dedicated branch off `main`.
2. **Isolated Git Worktrees**:
   - Each independent implementation task (`TASK-XXX`) uses its own Git worktree so parallel agents never contend on the same working tree or lockfiles.
   - Naming convention:
     - Worktree path: `../viblo_shorts-wt-<task-id>` (or `.worktrees/<task-id>` if git‑ignored).
     - Branch name: `feat/<task-id>-<short-slug>`, `fix/<task-id>-<short-slug>`, or `chore/<task-id>-<short-slug>`.
3. **No Concurrent File Editing**:
   - The `orchestrator` assigns explicit file ownership on `engineering/TASK_BOARD.md`.
   - Two active tasks must not modify the same file concurrently.
4. **Merge Gate (G5)**:
   - No agent may merge a branch into `main` without passing G3 (tests) and G4 (`independent‑reviewer`) **and** receiving explicit CTO approval.
5. **Cleanup**:
   - Remove temporary worktrees only after the branch is merged or closed and `git status` is clean.
