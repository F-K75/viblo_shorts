-- Track D-1 review R2 (owner decision 2026-11-09): AI billing follows actual provider usage.
-- Every provider attempt of a reservation is recorded:
--  * attempts_total / attempts_open: begun and not yet ended (an open attempt at settlement = outcome unknown);
--  * billable_attempts: the provider answered with usage > 0 (charged, even if the output was unusable);
--  * uncertain_attempts: the outcome is unknown (timeout, network error, no usage metadata) -> charged;
--  * billable_tokens: the provider-reported token total of the billable attempts (audit).
-- Settlement charges the reservation's unit iff any attempt was billable, uncertain or still open, or the row was
-- started by the previous release (started_at set, no attempt records); otherwise it refunds.
-- Expand-only: columns with constant defaults (no table rewrite on PostgreSQL 11+). The previous release never reads
-- them and keeps its own rule (started_at) if rolled back.
-- forge:backward-compatible
ALTER TABLE ai_reservations
  ADD COLUMN attempts_total int NOT NULL DEFAULT 0,
  ADD COLUMN attempts_open int NOT NULL DEFAULT 0,
  ADD COLUMN billable_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN uncertain_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN billable_tokens bigint NOT NULL DEFAULT 0;
