-- +goose Up
-- +goose StatementBegin
-- bd med-o7zq.22: anonymous trial VOICE for iOS local mode, metered in
-- seconds of call wall time (reserved up front, the unused part refunded when
-- the call ends). voice_seconds is the per-install LIFETIME count; existing
-- installs start at 0 (the full voice budget). The per-install DAILY seconds
-- live in attest_voice_usage, and the global daily voice budget is
-- SUM(seconds) for the day. Deliberately NOT trial_usage: its global SUM is
-- the AI-request budget. No call content, no tokens.
ALTER TABLE attest_installs ADD COLUMN voice_seconds INTEGER NOT NULL DEFAULT 0;
CREATE TABLE attest_voice_usage (
    day     TEXT NOT NULL,
    key_id  TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key_id)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE attest_voice_usage;
ALTER TABLE attest_installs DROP COLUMN voice_seconds;
-- +goose StatementEnd
