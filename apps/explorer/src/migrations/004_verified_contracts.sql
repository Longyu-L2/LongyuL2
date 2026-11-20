-- Contracts whose source someone has published: the explorer compiled it itself and the bytecode
-- matched the code at the address (verify/). A row does not hang off a block. It names the hash of
-- the code it was matched against, and a page shows it only while the address still holds that code.

CREATE TABLE verified_contracts (
  address TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The source file that defines the contract.
  file TEXT NOT NULL,
  -- The compiler's full version, as 0.8.28+commit.7893614a.
  compiler TEXT NOT NULL,
  optimizer BOOLEAN NOT NULL,
  runs BIGINT,
  evm_version TEXT,
  -- full: every byte, the metadata hash included. partial: every byte but the metadata hash.
  match_kind TEXT NOT NULL CHECK (match_kind IN ('full', 'partial')),
  -- The creation transaction's input was matched as well; constructor_args is what followed the code in it.
  creation_checked BOOLEAN NOT NULL,
  constructor_args TEXT,
  abi TEXT NOT NULL,
  -- The standard JSON input: language, sources and settings.
  input TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  verified_at BIGINT NOT NULL
);
