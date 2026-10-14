ALTER TABLE vaquinha_donation_orders
  ADD COLUMN IF NOT EXISTS charge_creation_started_at TIMESTAMPTZ;
