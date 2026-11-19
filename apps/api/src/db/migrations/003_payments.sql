-- Business orders paid in real USDT or BNB through PaymentRouter on BNB Smart Chain.
-- Products are services sold to partners. None of them may change mining rewards: there are no
-- paid boosts, upgrades or multipliers, and nothing here is read by settlement.

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  -- bytes32 sent on-chain with the payment: 32 random bytes, lower-case hex.
  order_id TEXT NOT NULL UNIQUE CHECK (order_id ~ '^0x[0-9a-f]{64}$'),
  customer TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('campaign', 'verification_api', 'advertising', 'services')),
  description TEXT NOT NULL,
  -- Checksummed token address; the zero address means BNB.
  token TEXT NOT NULL,
  amount NUMERIC(78, 0) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'review', 'refunded', 'cancelled')),
  review_reason TEXT,
  payment_id UUID,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  paid_at BIGINT,
  resolved_by TEXT,
  resolved_at BIGINT,
  resolution_note TEXT
);
CREATE INDEX orders_status_idx ON orders (status, created_at);

-- Every OrderPaid event seen after finality, matched or not, recorded exactly once.
CREATE TABLE payments (
  id UUID PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  router TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INT NOT NULL,
  block_number BIGINT NOT NULL,
  block_time BIGINT NOT NULL,
  order_id TEXT NOT NULL,
  order_ref UUID REFERENCES orders (id),
  payer TEXT NOT NULL,
  token TEXT NOT NULL,
  amount NUMERIC(78, 0) NOT NULL,
  -- The router's treasury when the payment was made, from its TreasurySet events.
  treasury TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('activated', 'underpaid', 'wrong_token', 'late', 'unknown_order', 'not_open', 'wrong_treasury')),
  refund_tx TEXT,
  refunded_by TEXT,
  refunded_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX payments_outcome_idx ON payments (outcome, created_at);

-- How far each router's events have been read, and its treasury at that point.
CREATE TABLE payment_cursor (
  router TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  treasury TEXT
);
