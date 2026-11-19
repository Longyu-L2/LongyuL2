-- Security review fixes (2026-11-17).

-- Rewards follow the wallet that was linked when the session started, not the wallet at settlement.
ALTER TABLE mining_sessions ADD COLUMN wallet_address TEXT;
UPDATE mining_sessions m SET wallet_address = w.address FROM wallets w WHERE w.user_id = m.user_id;

-- Sign-in codes: failures survive resends and lock the address; resends back off exponentially.
ALTER TABLE otp_codes ADD COLUMN failures INT NOT NULL DEFAULT 0;
ALTER TABLE otp_codes ADD COLUMN failures_since BIGINT NOT NULL DEFAULT 0;
ALTER TABLE otp_codes ADD COLUMN send_count INT NOT NULL DEFAULT 0;
ALTER TABLE otp_codes ADD COLUMN locked_until BIGINT NOT NULL DEFAULT 0;

-- Devices that keep failing attestation are locked before any call to Google or Apple.
ALTER TABLE devices ADD COLUMN attestation_locked_until BIGINT NOT NULL DEFAULT 0;

-- Challenge lookups are indexed; old challenges are cleaned up by the maintenance job.
CREATE INDEX challenges_lookup_idx ON challenges (user_id, purpose, nonce);
CREATE INDEX challenges_expiry_idx ON challenges (expires_at);

-- Faucet requests are queued and sent by the single job runner; one per address per day.
ALTER TABLE faucet_requests ADD COLUMN day BIGINT NOT NULL DEFAULT 0;
ALTER TABLE faucet_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE faucet_requests ADD COLUMN error TEXT;
CREATE UNIQUE INDEX faucet_one_per_day_idx ON faucet_requests (address, day);

-- Rewards held back from frozen addresses until no live root can pay them (see reward engine).
ALTER TABLE ledger_accounts ADD COLUMN reserve JSONB;
