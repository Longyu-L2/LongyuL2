-- A token's Transfer events say whatever its contract makes them say, so a holder's running balance
-- is not held to uint256: nine transfers of 2^256 - 1 pass the 78 digits of NUMERIC(78, 0), the
-- insert failed and the indexer stopped at that block. Without a precision the column holds any sum
-- the chain can produce (131,072 digits). Dropping the precision changes no stored value, so
-- Postgres does not rewrite the table; it rebuilds the two partial indexes on balance.
ALTER TABLE token_balances ALTER COLUMN balance TYPE NUMERIC;

-- Tokens whose metadata has not been read yet, for the retry pass (Indexer.retryMetadata).
CREATE INDEX tokens_metadata_pending_idx ON tokens (address) WHERE metadata_at IS NULL;
