-- Reward-asset transfers out of wallets that users have linked, for the wallet-sweep risk rule.
-- Only transfers from known user wallets are kept; native transfers use log_index -1.
CREATE TABLE wallet_transfers (
  tx_hash TEXT NOT NULL,
  log_index INT NOT NULL,
  block BIGINT NOT NULL,
  block_time BIGINT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX wallet_transfers_to_idx ON wallet_transfers (to_address, block_time);
CREATE INDEX wallet_transfers_time_idx ON wallet_transfers (block_time);
