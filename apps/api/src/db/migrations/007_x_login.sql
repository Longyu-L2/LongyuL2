-- Sign-in with X only. Email sign-in and its codes are removed.

-- An account is one X account, known by X's numeric user id (the username can change, and a freed
-- username can be taken by someone else).
ALTER TABLE users ADD COLUMN x_id TEXT;
ALTER TABLE users ADD COLUMN x_username TEXT;
-- Accounts made with an email address (development databases only: nothing was deployed) keep their
-- rows, but X never returns an id of this form, so nobody can sign in to them.
UPDATE users SET x_id = 'email:' || id WHERE x_id IS NULL;
ALTER TABLE users ALTER COLUMN x_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_x_id_key UNIQUE (x_id);
ALTER TABLE users DROP COLUMN email;
DROP TABLE otp_codes;

-- One row per sign-in started in the app. The app's browser goes to X and comes back to the API with
-- `state`; the API then hands the app a one-time ticket, which the app redeems together with the
-- verifier behind app_challenge. Only hashes of the state and the ticket are stored.
CREATE TABLE x_logins (
  id UUID PRIMARY KEY,
  state_hash TEXT UNIQUE NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign-in', 'wallet-change')),
  -- The signed-in user who asked to change their wallet; empty for a sign-in.
  user_id UUID REFERENCES users (id),
  app_challenge TEXT NOT NULL,
  -- The PKCE verifier sent to X with the code.
  x_verifier TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  -- Set when X redirects back, before the code is exchanged: a state works once.
  consumed_at BIGINT,
  x_id TEXT,
  x_username TEXT,
  ticket_hash TEXT UNIQUE,
  ticket_expires_at BIGINT,
  -- Set the first time the ticket is presented, whether or not it passes.
  ticket_used_at BIGINT,
  created_at BIGINT NOT NULL,
  CHECK ((purpose = 'wallet-change') = (user_id IS NOT NULL))
);
CREATE INDEX x_logins_expires_idx ON x_logins (expires_at);
