-- +goose Up
-- +goose StatementBegin
-- Daily trial-proxy request counters, per account and per UTC day.
--
-- Persisted rather than in-memory (unlike the per-minute sliding-window
-- limiter) because the cap it enforces is a spend cap on the OPERATOR's own
-- provider key: a redeploy must not hand every account a fresh budget, or a
-- crash-loop becomes a way to bill the operator without limit (bd med-d5t.5).
--
-- The global daily budget is SUM(requests) over a day, not a separate row: with
-- a handful of accounts the sum is trivial, and one source of truth cannot drift
-- from itself.
CREATE TABLE trial_usage (
    day        TEXT NOT NULL,             -- UTC 'YYYY-MM-DD'
    account_id TEXT NOT NULL,
    requests   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, account_id)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE trial_usage;
-- +goose StatementEnd
