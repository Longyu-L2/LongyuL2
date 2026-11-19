-- Background job heartbeats, for the health endpoint: when each job last ran, succeeded or failed.
CREATE TABLE job_runs (
  name TEXT PRIMARY KEY,
  last_started BIGINT,
  last_success BIGINT,
  last_error TEXT,
  last_error_at BIGINT,
  -- Failures since the last success.
  failures INT NOT NULL DEFAULT 0
);
