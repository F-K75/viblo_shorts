---
name: security-policy
role: Security Policy Rules
subagent: false
---

# Security Policy

1. **No Modifying Secrets or Production Credentials**:
   - Never commit `.env`, API keys, private keys, `SESSION_SECRET`, `TURNSTILE_SECRET`, `GEMINI_API_KEY`, or production database URLs.
   - Never modify production credentials or secret stores.
2. **No Destructive Database Migrations Without Approval**:
   - Any migration in `server/db/migrations/` that drops tables/columns, truncates data, or alters data destructively requires explicit CTO + `architect` approval.
3. **Security Controls Preservation**:
   - Preserve `TRUST_PROXY` validation, `SESSION_SECRET` production guards, Turnstile CAPTCHA enforcement, rate limiting (`server/lib/requestGuards.ts`), and security headers (`server/lib/security.ts`).
4. **Read-Only Audit Independence**:
   - `security-engineer` and `independent-reviewer` remain read‑only for audits and G4 reviews so they cannot alter the code they are auditing.
5. **CI Security Gates**:
   - Never weaken `bun audit` or add `continue‑on‑error: true` to security or test jobs in `.github/workflows/ci.yml`.
