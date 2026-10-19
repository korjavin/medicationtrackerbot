-- +goose Up
-- +goose StatementBegin
-- bd med-nt9p.32.8.3: the anonymous trial serves Android installs too (Play
-- Integrity enrollment, Keystore assertions). kind picks the assertion
-- verifier; every existing row is an iOS App Attest key.
ALTER TABLE attest_installs ADD COLUMN kind TEXT NOT NULL DEFAULT 'ios';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE attest_installs DROP COLUMN kind;
-- +goose StatementEnd
