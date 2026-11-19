-- LONGYU Scan schema. Hashes and addresses are lower-case 0x hex. Every row hangs off a block, so
-- undoing a reorganised block is one DELETE (token balances are reversed first; see indexer.ts).

CREATE TABLE blocks (
  number BIGINT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  miner TEXT NOT NULL,
  gas_used NUMERIC(78, 0) NOT NULL,
  gas_limit NUMERIC(78, 0) NOT NULL,
  base_fee NUMERIC(78, 0),
  size INTEGER,
  tx_count INTEGER NOT NULL
);

CREATE TABLE transactions (
  hash TEXT PRIMARY KEY,
  block_number BIGINT NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
  tx_index INTEGER NOT NULL,
  timestamp BIGINT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT,
  contract_address TEXT,
  value NUMERIC(78, 0) NOT NULL,
  nonce BIGINT NOT NULL,
  type INTEGER NOT NULL,
  gas_limit NUMERIC(78, 0) NOT NULL,
  gas_used NUMERIC(78, 0),
  gas_price NUMERIC(78, 0),
  l1_fee NUMERIC(78, 0),
  status SMALLINT,
  method_id TEXT,
  input TEXT NOT NULL,
  -- Deposit transactions (type 126) only.
  source_hash TEXT,
  mint NUMERIC(78, 0)
);
CREATE INDEX transactions_block_idx ON transactions (block_number DESC, tx_index DESC);
CREATE INDEX transactions_from_idx ON transactions (from_address, block_number DESC);
CREATE INDEX transactions_to_idx ON transactions (to_address, block_number DESC);
CREATE INDEX transactions_contract_idx ON transactions (contract_address) WHERE contract_address IS NOT NULL;
CREATE INDEX transactions_deposit_idx ON transactions (block_number DESC) WHERE type = 126;

CREATE TABLE logs (
  block_number BIGINT NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  address TEXT NOT NULL,
  topic0 TEXT,
  topic1 TEXT,
  topic2 TEXT,
  topic3 TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX logs_tx_idx ON logs (tx_hash);
CREATE INDEX logs_address_idx ON logs (address, topic0, block_number DESC);

CREATE TABLE tokens (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('erc20', 'erc721')),
  name TEXT,
  symbol TEXT,
  decimals INTEGER,
  first_block BIGINT NOT NULL,
  metadata_at TIMESTAMPTZ
);
CREATE INDEX tokens_symbol_idx ON tokens (lower(symbol));

CREATE TABLE token_transfers (
  block_number BIGINT NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  token TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  value NUMERIC(78, 0) NOT NULL,
  token_id NUMERIC(78, 0),
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX token_transfers_token_idx ON token_transfers (token, block_number DESC);
CREATE INDEX token_transfers_from_idx ON token_transfers (from_address, block_number DESC);
CREATE INDEX token_transfers_to_idx ON token_transfers (to_address, block_number DESC);
CREATE INDEX token_transfers_tx_idx ON token_transfers (tx_hash);

-- Kept in step with token_transfers inside the same database transaction.
CREATE TABLE token_balances (
  token TEXT NOT NULL,
  holder TEXT NOT NULL,
  balance NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (token, holder)
);
CREATE INDEX token_balances_holder_idx ON token_balances (holder) WHERE balance > 0;
CREATE INDEX token_balances_rank_idx ON token_balances (token, balance DESC) WHERE balance > 0;

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);
-- transactions: rows in the table above. pruned_to: the height up to which old blocks without
-- transactions have been deleted (see Indexer.prune).
INSERT INTO counters (name, value) VALUES ('transactions', 0), ('pruned_to', -1);
