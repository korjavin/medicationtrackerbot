-- +goose Up
-- +goose StatementBegin
-- med-wi09.8: the dose-ledger cut as an account fact. Set once, by the first
-- oplog op whose plaintext record_type_tag is 'ledgercut' (its assigned seq +
-- server time, RFC3339 UTC); NULL = no cut, writer gate inert. Numbered 036:
-- 035 is reserved by an unmerged branch (035_transfer_slot_v2.sql).
ALTER TABLE accounts ADD COLUMN ledger_cut_seq INTEGER;
ALTER TABLE accounts ADD COLUMN ledger_cut_at TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE accounts DROP COLUMN ledger_cut_at;
ALTER TABLE accounts DROP COLUMN ledger_cut_seq;
-- +goose StatementEnd
