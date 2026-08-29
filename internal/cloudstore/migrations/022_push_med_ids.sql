-- +goose Up
-- +goose StatementBegin
-- med-kbpf: the reminder ROW carries the identity of the meds its message named,
-- so a Telegram Confirm tap resolves to those doses without the browser having to
-- reconstruct them from a vault side-table (the deleted `slotmeds` records, whose
-- every reconstruction failure meant 6h of hourly nags for doses already taken).
--
-- tg_med_ids is comma-separated numeric medication record ids, CLEARTEXT to the
-- relay exactly like tg_text — and strictly less than tg_text already reveals at
-- 'detailed' verbosity, where it holds the medication NAMES. Only meaningful on
-- med rows (an "s:<slotUnix>" tg_callback); empty everywhere else. The relay never
-- reads `ct`. Cleared with tg_text/tg_callback on send (MarkPushSent).
-- DEFAULT '' covers all pre-existing rows and every untouched INSERT.
ALTER TABLE scheduled_pushes ADD COLUMN tg_med_ids TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN tg_med_ids;
-- +goose StatementEnd
