-- Track B (R-04, F7): fair render queue, bounded retries, queue-wait expiry.
--  * attempts:   how many times a worker claimed the job. A job whose worker keeps dying is failed after
--                RENDER_MAX_ATTEMPTS instead of being requeued forever.
--  * claimed_at: when the job was last claimed. A user's latest claim decides fairness: the queued job of the user
--                served least recently runs first, so one user's backlog cannot starve another user.
--  * queued_at:  when the job (re-)entered the queue. Jobs waiting longer than RENDER_QUEUE_TTL_S expire.
-- Billing is not a column: the completion and the render-minute charge are one transaction (pgRepo.completeJob).
-- Expand-only: the previous release ignores these columns (it claims FIFO and never reads them).
-- forge:backward-compatible
ALTER TABLE jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN claimed_at timestamptz;
ALTER TABLE jobs ADD COLUMN queued_at timestamptz;
CREATE INDEX jobs_queue_user_idx ON jobs (user_id, status) WHERE status IN ('queued', 'processing');
