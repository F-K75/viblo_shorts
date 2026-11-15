# Engineering Standards

## 1. Preserve Existing Functionality
- Do not break existing endpoints, UI flows, or data contracts.
- Maintain parity between server-side JSON storage and PostgreSQL.
- Keep offline Gemini fallback behavior untouched unless explicitly approved.

## 2. Code Quality
- Functions should be small, single‑purpose, and shallowly nested.
- Avoid duplicated logic across `server.ts`, `server/lib/*`, `server/db/*`, and `src/*`.
- Handle errors explicitly; never swallow exceptions silently.

## 3. Mandatory Testing
- Every implementation must include or update automated tests in `tests/`.
- Run `npm run lint` and relevant test suites after the final edit.
- Report exact observed pass/fail/skip counts. Do not claim skipped tests as passed.

## 4. Blocker Documentation
- Any missing dependency, environment limitation, failing external service, or conflicting requirement must be logged immediately as `BLOCKED` in `engineering/TASK_BOARD.md` with owner, root cause, and unblock criteria.

## 5. Evidence‑Only Reporting
- Cite only file paths, symbol names, and command outputs directly observed in the current workspace.
