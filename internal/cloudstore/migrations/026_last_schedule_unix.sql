-- +goose Up
-- +goose StatementBegin
-- med-ei2: exact 'reminders deliberately off' vs 'browser stopped
-- re-uploading' signal for the dry-queue safety net. Stamped by
-- ReplaceSchedule (the PUT /api/push/schedule replace-all) on every upload,
-- empty batches included — an account that turns every reminder off uploads
-- an empty schedule, which is otherwise byte-for-byte identical to a rotted
-- horizon. NULL means 'no schedule PUT observed since this column landed'
-- and keeps the med-2lx backward-window predicate byte-for-byte.
ALTER TABLE sync_state ADD COLUMN last_schedule_unix INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_state DROP COLUMN last_schedule_unix;
-- +goose StatementEnd
