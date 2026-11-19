-- All times are unix seconds (BIGINT). All token amounts are wei (NUMERIC(78,0)).

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  tier SMALLINT NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
  referral_code TEXT UNIQUE NOT NULL,
  referred_by UUID REFERENCES users(id),
  country TEXT,
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  banned_day BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  install_id TEXT NOT NULL,
  attested_at BIGINT,
  attestation_key_id TEXT,
  attestation_public_key TEXT,
  attestation_sign_count BIGINT NOT NULL DEFAULT 0,
  attestation_failures INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  UNIQUE (user_id, install_id)
);
CREATE INDEX devices_install_idx ON devices (install_id);

CREATE TABLE otp_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  sent_at BIGINT NOT NULL
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  family UUID NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE INDEX refresh_family_idx ON refresh_tokens (family);

CREATE TABLE challenges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('attest', 'siwe', 'session', 'babt')),
  nonce TEXT NOT NULL,
  pulse_required BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  address TEXT UNIQUE NOT NULL,
  linked_at BIGINT NOT NULL,
  change_available_at BIGINT NOT NULL
);

CREATE TABLE wallet_changes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  from_address TEXT NOT NULL,
  to_address TEXT UNIQUE NOT NULL,
  effective_day BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE mining_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  started_at BIGINT NOT NULL,
  credited_day BIGINT NOT NULL,
  ip TEXT,
  pulse_passed BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (user_id, credited_day)
);
CREATE INDEX sessions_day_idx ON mining_sessions (credited_day);

CREATE TABLE streaks (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  streak_days INT NOT NULL DEFAULT 0,
  grace_banked INT NOT NULL DEFAULT 0,
  consecutive INT NOT NULL DEFAULT 0,
  last_applied_day BIGINT
);

CREATE TABLE tier_events (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  from_tier SMALLINT NOT NULL,
  to_tier SMALLINT NOT NULL,
  reason TEXT NOT NULL,
  day BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX tier_events_day_idx ON tier_events (day);

CREATE TABLE verifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'approved', 'rejected', 'duplicate')),
  unique_key TEXT,
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);
-- One verified identity (face, BABT holder, passport) per account.
CREATE UNIQUE INDEX verifications_unique_identity ON verifications (unique_key) WHERE status = 'approved';

CREATE TABLE flags (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('watch', 'hold')),
  detail JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'confirmed')),
  day BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_by TEXT,
  resolved_at BIGINT,
  UNIQUE (user_id, kind, day)
);

CREATE TABLE admin_actions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ban')),
  target_user UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'rejected')),
  created_at BIGINT NOT NULL,
  executed_at BIGINT
);

CREATE TABLE appeals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'denied')),
  response TEXT,
  created_at BIGINT NOT NULL,
  resolved_by TEXT
);

CREATE TABLE ledger_accounts (
  address TEXT PRIMARY KEY,
  cumulative NUMERIC(78, 0) NOT NULL,
  claimed NUMERIC(78, 0) NOT NULL,
  pending JSONB NOT NULL DEFAULT '[]',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  frozen BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE ledger_meta (
  id INT PRIMARY KEY CHECK (id = 1),
  last_settled_day BIGINT
);
INSERT INTO ledger_meta (id, last_settled_day) VALUES (1, NULL);

CREATE TABLE settlements (
  day BIGINT PRIMARY KEY,
  root TEXT,
  total_entitled NUMERIC(78, 0) NOT NULL,
  data_hash TEXT NOT NULL,
  data_uri TEXT,
  stats JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('computed', 'empty', 'posted', 'active', 'vetoed', 'superseded')),
  tx_hash TEXT,
  created_at BIGINT NOT NULL,
  posted_at BIGINT
);

CREATE TABLE proofs (
  day BIGINT NOT NULL,
  address TEXT NOT NULL,
  cumulative NUMERIC(78, 0) NOT NULL,
  proof JSONB NOT NULL,
  PRIMARY KEY (day, address)
);

CREATE TABLE claims (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  address TEXT NOT NULL,
  day BIGINT,
  cumulative NUMERIC(78, 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'confirmed', 'skipped', 'failed')),
  tx_hash TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX claims_one_open_idx ON claims (address) WHERE status IN ('queued', 'sent');

CREATE TABLE claimed_onchain (
  address TEXT PRIMARY KEY,
  cumulative NUMERIC(78, 0) NOT NULL
);

CREATE TABLE chain_cursor (
  name TEXT PRIMARY KEY,
  block BIGINT NOT NULL
);

CREATE TABLE faucet_requests (
  id UUID PRIMARY KEY,
  address TEXT NOT NULL,
  ip TEXT,
  created_at BIGINT NOT NULL,
  tx_hash TEXT
);
CREATE INDEX faucet_address_idx ON faucet_requests (address, created_at);
CREATE INDEX faucet_ip_idx ON faucet_requests (ip, created_at);

CREATE TABLE push_tokens (
  user_id UUID NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  PRIMARY KEY (user_id, token)
);

CREATE TABLE reminders (
  user_id UUID NOT NULL REFERENCES users(id),
  day BIGINT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE job_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
