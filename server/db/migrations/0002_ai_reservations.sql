-- R-02: AI quota reservation ledger. Every AI call reserves one unit per key under a client-generated id and
-- is later settled exactly once (committed = charged, refunded = returned). Settling is a conditional status
-- transition, so a retried or duplicated settle is a no-op (no double refund), and a retried reserve with the
-- same id is a no-op (no double charge). Reservations never settled (crash, failed settle) are refunded by
-- expiry, so a failed request cannot consume quota permanently.
-- Lock order everywhere: ai_reservations row (unique per call) -> ai_usage_daily rows in ascending key order.
CREATE TABLE ai_reservations (
  id          text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  day         date NOT NULL,
  keys        text[] NOT NULL,
  status      text NOT NULL CHECK (status IN ('reserved', 'committed', 'refunded')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz
);
-- expiry scan touches only open reservations
CREATE INDEX ai_reservations_open_idx ON ai_reservations (created_at) WHERE status = 'reserved';
-- retention sweep of settled rows
CREATE INDEX ai_reservations_settled_idx ON ai_reservations (settled_at) WHERE status <> 'reserved';
