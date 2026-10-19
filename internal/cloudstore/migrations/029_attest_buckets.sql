-- +goose Up
-- +goose StatementBegin
-- bd med-o7zq.26: anonymous-trial budgets move from the install (one App
-- Attest key) to a BUCKET (one device's trial), so a reinstall that presents
-- the bucket's trial pass (kept in the iOS Keychain) rejoins it and every
-- install of the bucket spends ONE budget. bucket_id is the founding install's
-- key id; pass_hash is SHA-256 of the pass secret (NULL for buckets
-- backfilled here, which never had a pass). used / voice_seconds are the
-- bucket's lifetime counts; the daily rows (trial_usage 'attest:' /
-- 'attest-food:' subjects, attest_voice_usage.key_id) are keyed by bucket_id.
-- Backfill: one bucket per existing install with its counters, bucket_id =
-- key_id, so the existing daily rows already belong to it. The old per-install
-- used / voice_seconds columns are left in place and no longer read.
CREATE TABLE attest_buckets (
    bucket_id     TEXT PRIMARY KEY,
    pass_hash     BLOB,
    used          INTEGER NOT NULL DEFAULT 0,
    voice_seconds INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);
INSERT INTO attest_buckets (bucket_id, used, voice_seconds, created_at)
    SELECT key_id, used, voice_seconds, created_at FROM attest_installs;
ALTER TABLE attest_installs ADD COLUMN bucket_id TEXT NOT NULL DEFAULT '';
UPDATE attest_installs SET bucket_id = key_id;
CREATE INDEX attest_installs_bucket ON attest_installs (bucket_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE attest_installs SET
    used = COALESCE((SELECT used FROM attest_buckets b WHERE b.bucket_id = attest_installs.key_id), used),
    voice_seconds = COALESCE((SELECT voice_seconds FROM attest_buckets b WHERE b.bucket_id = attest_installs.key_id), voice_seconds);
DROP INDEX attest_installs_bucket;
ALTER TABLE attest_installs DROP COLUMN bucket_id;
DROP TABLE attest_buckets;
-- +goose StatementEnd
