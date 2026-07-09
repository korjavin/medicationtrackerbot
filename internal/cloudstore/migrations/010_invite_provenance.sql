-- +goose Up
-- +goose StatementBegin
-- Which account minted this account's invite. NULL for admin-CLI invites and
-- every pre-existing row. Doubles as the monthly invite quota counter: the
-- number of rows with created_by_account_id = X and a recent created_at_unix.
ALTER TABLE accounts ADD COLUMN created_by_account_id TEXT;
CREATE INDEX idx_accounts_created_by ON accounts(created_by_account_id, created_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_accounts_created_by;
ALTER TABLE accounts DROP COLUMN created_by_account_id;
-- +goose StatementEnd
