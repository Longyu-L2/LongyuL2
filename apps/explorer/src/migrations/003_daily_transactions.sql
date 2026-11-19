-- Transactions made in each UTC day (day = block timestamp / 86400), for the chart on the home page.
-- The indexer keeps it with the transactions counter: a block adds its transactions and a rollback
-- takes them away. Days before this migration are counted from the rows already stored.
CREATE TABLE daily_transactions (
  day   INTEGER PRIMARY KEY,
  count BIGINT NOT NULL
);

INSERT INTO daily_transactions (day, count)
SELECT (timestamp / 86400)::int, count(*) FROM transactions GROUP BY 1;

-- The home page counts the transactions of the last 24 hours.
CREATE INDEX transactions_timestamp_idx ON transactions (timestamp);
