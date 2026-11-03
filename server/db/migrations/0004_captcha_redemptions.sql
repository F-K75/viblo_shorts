-- Track A (R-03): CAPTCHA tokens are single-use across all instances. The server stores sha256(token) (never the
-- token) here atomically before asking the provider; a second redemption of the same hash is refused. Rows expire
-- after the token's maximum age plus a margin and are deleted by the maintenance sweep.
-- Guest-mint budgets and the hourly baseline series reuse window_counters (keys 'gm:*' and 'stats:*'); no change.
-- Expand-only: a new table the previous release never touches.
-- forge:backward-compatible
CREATE TABLE captcha_redemptions (
  token_hash  text PRIMARY KEY CHECK (length(token_hash) BETWEEN 16 AND 128),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX captcha_redemptions_expiry_idx ON captcha_redemptions (expires_at);
