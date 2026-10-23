-- +goose Up
-- +goose StatementBegin
-- bd med-ta2n.25: an install can be keyed WITHOUT a trial grant (enroll with
-- "trial": false) so every local install can sign feedback without spending
-- the device's DeviceCheck / Play recall bit. granted = 0 marks such a bucket:
-- the chat, food and voice routes refuse it (trial_not_granted), feedback
-- accepts it. Every existing bucket passed the grant gate or was backfilled
-- from a granted install, hence DEFAULT 1.
ALTER TABLE attest_buckets ADD COLUMN granted INTEGER NOT NULL DEFAULT 1;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Ungranted buckets then read as granted trials: their installs could spend
-- the trial without a DeviceCheck / recall check. Drop them first; their keys
-- answer install_unknown and the client re-enrolls. Their feedback_queue rows
-- ('attest:' || bucket_id, no FK) are kept for the drain.
DELETE FROM attest_installs WHERE bucket_id IN (SELECT bucket_id FROM attest_buckets WHERE granted = 0);
DELETE FROM attest_buckets WHERE granted = 0;
ALTER TABLE attest_buckets DROP COLUMN granted;
-- +goose StatementEnd
