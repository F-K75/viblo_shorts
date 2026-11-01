# Guest Data Retention — Proposal (NOT implemented; awaiting approval)

> Status: **proposal only.** No guest data is deleted, archived or expired by the current code.

## 1. Current behaviour (facts)
* A guest session is an HMAC-signed token with a random id (`guest_<32 hex>`), valid for **30 days**, stored in
  the browser's `localStorage`. It cannot be renewed or recovered. A new token means a new identity.
* Guest projects are stored like any user's projects. Limits: 10 projects / 5 MB per guest, 512 MB across all
  guests.
* After the token expires, or after the user clears browser storage or signs out (FS-006), the projects are
  **unreachable but kept forever**. Once the guest pool fills, new guests can no longer save (FS-034).
* Signing up does not carry guest projects over (FS-006, Phase 3).

## 2. Goals
1. Never lose work a person can still reach or reasonably expects to keep.
2. Give guests a clear, honest path to keep their work: create an account and claim it.
3. Bound storage, and keep personal data only while it serves its purpose (GDPR storage limitation).

## 3. Proposal
| # | Rule | Default | Notes |
|---|---|---|---|
| R1 | **Sliding guest session**: the token is re-issued (same guest id) on use when it is older than 7 days | lifetime 30 days since **last use** | Requires a refresh endpoint; prevents active guests from losing access |
| R2 | **Account claim**: signing up or signing in with a valid guest token moves all guest projects to the account, in one transaction, idempotently | always offered | Phase 3 (FS-006). Needs both tokens; never merges into an account by id alone |
| R3 | Pre-expiry warning in the UI from day 23 since last use ("sign up to keep your projects") | on | No e-mail possible for guests |
| R4 | **Soft expiry** at 30 days since last activity: projects hidden and marked `expired_at`, still restorable | 30 days | Nothing is deleted here |
| R5 | **Recovery window** 30 days after soft expiry: a guest who still has the old token (e.g. a restored browser) can claim it | 30 days | Total retention ≈ 60 days after last use |
| R6 | **Hard deletion** after the recovery window, by a daily job, in batches, with an audit log (counts, never content) | after day 60 | Backups age out under the backup retention policy (≤ 35 days of dailies) |
| R7 | Signed-in users' data is never expired by this policy | — | Account deletion is a separate feature (FS-014) |
| R8 | Admin export/hold: a legal hold flag excludes a guest id from R4–R6 | off | For support or legal requests |

## 4. Safety requirements for the implementation (when approved)
* A dry-run mode that reports how many guests/projects would be soft-expired/deleted, and their total bytes.
* Deletion only of records soft-expired ≥ 30 days earlier, and only after a successful verified off-site backup
  within the previous 24 h.
* Rate-limited batches; the job is idempotent and uses an advisory lock (one instance).
* Metrics: guests active, soft-expired, deleted per day; pool usage.
* Tests: claim moves exactly the guest's projects; expired-then-claimed restores everything; deletion never
  touches signed-in users or held ids.

## 4a. Update after your review (2026-11-01)
Your direction: **30 days of inactivity** as the proposed expiry threshold, a recovery grace period, account
claiming, user notification where applicable, secure deletion after the approved period, and **no deletion of
existing data until you approve**. The proposal above already uses 30 days since *last activity* (R4) plus a
30-day recovery window (R5). Specifics added:
* **Inactivity** = no authenticated request with that guest token (reads count) for 30 days; tracked in
  `users.last_seen_at` (already maintained on writes in PostgreSQL; reads to be added).
* **Notification:** guests have no e-mail, so notice is in-app: a banner from day 23 ("sign up to keep your
  projects"), and on soft-expiry a restore notice if the same browser returns. Claimed accounts are never
  subject to guest expiry.
* **Secure deletion:** hard delete in batches inside transactions (project rows, then user row), recorded in an
  audit table with counts only. Data then ages out of backups within the backup retention (≤ 35 days), which the
  privacy policy must state. Storage-level deletion relies on the provider's encrypted-at-rest guarantees
  (CMK; key destruction is not per-user).
* **Existing guest data:** the first run is **dry-run only** and reports counts for your approval. Nothing is soft-
  or hard-deleted before that approval.

## 5. Decisions needed
1. Approve R1–R8 (or adjust the 30 + 30 day windows).
2. Confirm the privacy-policy wording for guest data (FS-014).
3. Confirm that backups may keep deleted guest data for up to the backup retention period (35 days).
