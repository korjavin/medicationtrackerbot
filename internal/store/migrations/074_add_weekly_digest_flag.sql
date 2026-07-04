-- +goose Up
-- +goose StatementBegin
-- default-OFF: unlike most feature flags, the opt-in Sunday digest must not
-- start sending until the user explicitly turns it on (gamification-12 Task 5).
ALTER TABLE settings ADD COLUMN weekly_digest_enabled INTEGER DEFAULT 0;

-- Tracks the last time the scheduled digest was actually sent, so the
-- Sunday-evening ticker (which polls every 15 min) doesn't resend within the
-- same hour window. NULL means "never sent".
ALTER TABLE settings ADD COLUMN weekly_digest_last_sent_at_unix INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE settings DROP COLUMN weekly_digest_last_sent_at_unix;
ALTER TABLE settings DROP COLUMN weekly_digest_enabled;
-- +goose StatementEnd
