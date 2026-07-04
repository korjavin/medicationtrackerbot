-- +goose Up
-- +goose StatementBegin
-- go-webauthn validates the assertion's backup-eligible flag against the
-- stored credential at login; without persisting it, synced passkeys (Apple
-- Passwords, Google Password Manager, 1Password — BE=1) always fail unlock.
ALTER TABLE credentials ADD COLUMN backup_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credentials ADD COLUMN backup_state INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE credentials DROP COLUMN backup_state;
ALTER TABLE credentials DROP COLUMN backup_eligible;
-- +goose StatementEnd
