-- The invite bonus counts an account's invited accounts in every status answer and at each
-- settlement, so they are found by who invited them.
CREATE INDEX users_referred_by_idx ON users (referred_by) WHERE referred_by IS NOT NULL;
