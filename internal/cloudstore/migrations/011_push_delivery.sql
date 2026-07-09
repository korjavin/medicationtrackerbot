-- +goose Up
-- +goose StatementBegin
-- C3b outbound (med-76c.1): a scheduled push can now fire over web push, over
-- the account's linked Telegram bot, or both. `ct` stays opaque NK ciphertext
-- the relay cannot read; `tg_text` is plaintext the client hands the relay to
-- forward verbatim to Telegram at the user's chosen verbosity. The relay never
-- derives tg_text from the vault — it only forwards bytes it was given.
--
-- Defaults reproduce today's behavior exactly, so pre-existing rows and older
-- clients (which send no delivery field) stay web-push-only.
ALTER TABLE scheduled_pushes ADD COLUMN delivery TEXT NOT NULL DEFAULT 'webpush';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE scheduled_pushes ADD COLUMN tg_text TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN tg_text;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN delivery;
-- +goose StatementEnd
