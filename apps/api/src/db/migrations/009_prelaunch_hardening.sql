-- Fixes from the review before launch (2026-11-19).

-- A faucet drip that fails for a passing reason stays queued and is tried again: how many tries so
-- far, and the earliest time of the next one.
ALTER TABLE faucet_requests ADD COLUMN attempts INT NOT NULL DEFAULT 0;
ALTER TABLE faucet_requests ADD COLUMN next_attempt_at BIGINT NOT NULL DEFAULT 0;

-- Sign-ins sent to X per UTC day (unix time / 86400). Each one is a billed read of the account, so
-- a day has a ceiling (X_DAILY_SIGNIN_LIMIT).
CREATE TABLE x_signin_days (
  day BIGINT PRIMARY KEY,
  exchanges INT NOT NULL DEFAULT 0 CHECK (exchanges >= 0)
);
-- For the short wait between two sign-ins of one X account.
CREATE INDEX x_logins_x_id_idx ON x_logins (x_id, consumed_at);

-- When a push token was registered: a user keeps the newest few. Tokens from before count as oldest.
ALTER TABLE push_tokens ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0;

-- One open appeal per user, held by the database and not only by the API's check. Should a user
-- already have several open, the first stays open and the later ones are closed with a note.
UPDATE appeals SET status = 'denied', response = 'Closed as a duplicate: your earlier appeal is still open.', resolved_by = 'system'
WHERE status = 'open' AND EXISTS (
  SELECT 1 FROM appeals o
  WHERE o.user_id = appeals.user_id AND o.status = 'open'
    AND (o.created_at < appeals.created_at OR (o.created_at = appeals.created_at AND o.id < appeals.id))
);
CREATE UNIQUE INDEX appeals_one_open_idx ON appeals (user_id) WHERE status = 'open';
