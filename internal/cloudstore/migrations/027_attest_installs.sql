-- +goose Up
-- +goose StatementBegin
-- bd med-o7zq.15: anonymous AI trial for iOS local mode. One row per App
-- Attest key (one per app install); no account. public_key is the PKIX DER of
-- the key VerifyAttestation returned, counter the last accepted assertion
-- counter (replay guard, compare-and-set), used the lifetime request count.
-- The per-install DAILY count lives in trial_usage under subject
-- 'attest:'||key_id so the global daily budget covers accounts and installs.
-- No device token, no prompt text.
CREATE TABLE attest_installs (
    key_id       TEXT PRIMARY KEY,
    public_key   BLOB NOT NULL,
    counter      INTEGER NOT NULL DEFAULT 0,
    used         INTEGER NOT NULL DEFAULT 0,
    env          TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE attest_installs;
-- +goose StatementEnd
