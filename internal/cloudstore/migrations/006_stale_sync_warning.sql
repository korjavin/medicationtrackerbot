-- +goose Up
-- +goose StatementBegin
-- Task 7 stale-sync warning: tracks the last time an account was sent the
-- generic "queue running dry" push, so the hourly sweep fires at most once a
-- day per account.
ALTER TABLE sync_state ADD COLUMN last_warned_unix INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_state DROP COLUMN last_warned_unix;
-- +goose StatementEnd
