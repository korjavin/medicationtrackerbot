-- +goose Up
-- +goose StatementBegin
-- med-wi09.14: relay fencing. The fence of the last fenced PUT
-- /api/push/schedule: the dose-ledger generation the horizon was built under
-- and the account seq the device had pulled (based_on_seq). A PUT is accepted
-- only when (generation, based_on_seq) >= the stored pair, compared in the
-- same upsert that stamps last_schedule_unix. 0/0 = never fenced; a legacy
-- PUT (no fence in the body) leaves both untouched.
ALTER TABLE sync_state ADD COLUMN schedule_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN schedule_generation INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_state DROP COLUMN schedule_generation;
ALTER TABLE sync_state DROP COLUMN schedule_seq;
-- +goose StatementEnd
