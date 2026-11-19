-- Sign-ins sent to X per client and UTC day, beside the day's total in x_signin_days. One client has
-- a small ceiling of its own, so it cannot use up the day for everyone. `client` is the address a
-- per-address limit counts against (IPv4 whole, IPv6 as its /64), as mining_sessions.ip keeps it.
-- Rows of earlier days are deleted by the cleanup job.
CREATE TABLE x_signin_clients (
  day BIGINT NOT NULL,
  client TEXT NOT NULL,
  exchanges INT NOT NULL DEFAULT 0 CHECK (exchanges >= 0),
  PRIMARY KEY (day, client)
);
