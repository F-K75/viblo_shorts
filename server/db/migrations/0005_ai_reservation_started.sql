-- Track D-1 F10: AI reservation lifecycle. started_at records the atomic transition "model call started".
-- States (status + started_at): reserved (open, started_at NULL) -> started (open, started_at set) -> committed | refunded.
--  * a client abort refunds only a reservation that never started; once started, an abort is charged;
--  * expiry (crash, failed settle) refunds a reservation that never started and commits one that started (uncertain);
--  * a settled reservation can never start, so a refunded call never reaches the model.
-- Expand-only: a nullable column the previous release never reads (it keeps its old semantics if rolled back).
-- forge:backward-compatible
ALTER TABLE ai_reservations ADD COLUMN started_at timestamptz;
