-- +goose Up
-- +goose StatementBegin
-- C3b inbound (med-76c.2): a Telegram reminder can carry inline Confirm/Snooze
-- buttons. `tg_callback` is the opaque, deterministic callback_data STEM the
-- client chose for this entry — "s:<slotUnix>" — to which the relay appends
-- ":confirm" / ":snooze" when it builds the two buttons.
--
-- It is a stem rather than a med name or intake id so the relay learns nothing
-- it did not already know: a dose slot's fire_at_unix is already in this table
-- in the clear. Empty means "no buttons", which is what every pre-C3b row and
-- every non-medication reminder (BP, weight, dry-queue warning) stores.
ALTER TABLE scheduled_pushes ADD COLUMN tg_callback TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN tg_callback;
-- +goose StatementEnd
