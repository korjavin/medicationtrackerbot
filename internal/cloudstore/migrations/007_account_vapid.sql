-- +goose Up
-- +goose StatementBegin
-- Per-account VAPID keypair, generated at invite provisioning. Push services
-- bind a subscription to the applicationServerKey used at subscribe() time
-- and reject pushes signed with a different key, so per-account keys make
-- Apple/Google themselves reject any relay bug that misroutes a payload.
-- Nullable: pre-existing rows are backfilled once at cmd/cloud startup.
ALTER TABLE accounts ADD COLUMN vapid_public_key TEXT;
ALTER TABLE accounts ADD COLUMN vapid_private_key TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE accounts DROP COLUMN vapid_private_key;
ALTER TABLE accounts DROP COLUMN vapid_public_key;
-- +goose StatementEnd
