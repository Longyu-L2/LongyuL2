-- Work a phone does to start a mining session: a short puzzle on the challenge's nonce, and a state
-- root posted on BSC rebuilt from LONGYU's own data. While a session runs, the app checks newer
-- state roots and reports each one.
ALTER TABLE challenges ADD COLUMN work_bits INTEGER;
ALTER TABLE challenges ADD COLUMN work_output_index BIGINT;
ALTER TABLE mining_sessions ADD COLUMN chain_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mining_sessions ADD COLUMN last_checked_output BIGINT;

-- A state root on BSC that this API's own node does not rebuild either: the chain and what was
-- posted for it disagree.
CREATE TABLE chain_check_alerts (
  output_index BIGINT PRIMARY KEY,
  l2_block BIGINT NOT NULL,
  posted_root TEXT NOT NULL,
  computed_root TEXT NOT NULL,
  found_at BIGINT NOT NULL
);
