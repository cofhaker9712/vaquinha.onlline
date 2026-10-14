CREATE TABLE IF NOT EXISTS vaquinha_donation_orders (
  id UUID PRIMARY KEY,
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'MED')),
  transaction_id TEXT UNIQUE,
  pix_code TEXT,
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  tracking JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vaquinha_webhook_events (
  transaction_id TEXT NOT NULL,
  event TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (transaction_id, event)
);

CREATE INDEX IF NOT EXISTS vaquinha_donation_orders_pending_idx
  ON vaquinha_donation_orders (last_checked_at)
  WHERE status = 'PENDING';
