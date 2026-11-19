-- Paid mining boosts. A boost multiplies a verified miner's weight
-- inside the fixed daily budget for a number of days; it never raises the day's emission.

-- Boosts are bought as orders, paid in real USDT or BNB through PaymentRouter on BSC.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_product_check;
ALTER TABLE orders ADD CONSTRAINT orders_product_check
  CHECK (product IN ('campaign', 'verification_api', 'advertising', 'services', 'mining_boost'));
ALTER TABLE orders ADD COLUMN user_id UUID REFERENCES users (id);
-- What was bought, fixed at purchase time so later plan or price changes never alter a paid order.
ALTER TABLE orders ADD COLUMN boost_plan TEXT;
ALTER TABLE orders ADD COLUMN boost_bps INT;
ALTER TABLE orders ADD COLUMN boost_days INT;
ALTER TABLE orders ADD CONSTRAINT orders_boost_shape CHECK (
  (product = 'mining_boost') = (user_id IS NOT NULL AND boost_plan IS NOT NULL AND boost_bps BETWEEN 1 AND 10000 AND boost_days BETWEEN 1 AND 365)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at);

-- One row per paid boost, covering mining days [start_day, end_day). A user's boosts never overlap:
-- a new one starts when the previous ends.
CREATE TABLE mining_boosts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  order_id UUID NOT NULL UNIQUE REFERENCES orders (id),
  boost_bps INT NOT NULL CHECK (boost_bps BETWEEN 1 AND 10000),
  start_day BIGINT NOT NULL,
  end_day BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  -- Set when the boost is withdrawn (a refund) before it began.
  cancelled_at BIGINT,
  CHECK (end_day > start_day)
);
CREATE INDEX mining_boosts_user_idx ON mining_boosts (user_id, start_day);
