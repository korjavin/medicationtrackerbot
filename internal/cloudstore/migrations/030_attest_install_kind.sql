-- +goose Up
-- +goose StatementBegin
-- bd med-nt9p.32.8.3: the anonymous trial serves Android installs too (Play
-- Integrity enrollment, Keystore assertions). kind picks the assertion
-- verifier; every existing row is an iOS App Attest key.
ALTER TABLE attest_installs ADD COLUMN kind TEXT NOT NULL DEFAULT 'ios';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Android rows cannot survive without kind (a later Up would relabel them
-- ios and the Apple verifier would reject every assertion, with no recovery).
-- Dropping them makes those clients see install_unknown and enroll a new key;
-- the trial pass rejoins their bucket, which is kept.
DELETE FROM attest_installs WHERE kind = 'android';
ALTER TABLE attest_installs DROP COLUMN kind;
-- +goose StatementEnd
