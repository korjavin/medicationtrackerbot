-- +goose Up
-- +goose StatementBegin
-- med-ei2: exact 'reminders deliberately off' vs 'browser stopped
-- re-uploading' signal for the dry-queue safety net. Stamped by
-- ReplaceSchedule (the PUT /api/push/schedule replace-all) on every upload:
-- last_schedule_unix records WHEN the client last pushed a schedule, and
-- last_schedule_empty (1 = the batch was empty, 0 = it carried entries)
-- records WHAT it pushed — an account that turns every reminder off uploads
-- an empty schedule, which is otherwise byte-for-byte identical to a rotted
-- horizon, however long ago the upload was. NULL means 'no schedule PUT
-- observed since these columns landed' and keeps the med-2lx backward-window
-- predicate byte-for-byte.
ALTER TABLE sync_state ADD COLUMN last_schedule_unix INTEGER;
ALTER TABLE sync_state ADD COLUMN last_schedule_empty INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_state DROP COLUMN last_schedule_empty;
ALTER TABLE sync_state DROP COLUMN last_schedule_unix;
-- +goose StatementEnd
