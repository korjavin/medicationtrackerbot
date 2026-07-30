-- +goose Up
-- +goose StatementBegin
-- Short-lived capability tokens for the web-feedback reader page (bd med-rbl.1).
--
-- cmd/cloud has no admin HTTP surface and no admin accounts — admin ops are a
-- CLI subcommand on the host. So the capability IS the token: it is minted when
-- the manager bot DMs the developer that web feedback arrived, delivered over
-- that already-authenticated channel, and it is the only thing gating
-- GET /api/feedback/queue.
--
-- token_hash is SHA-256 of the token, never the token itself — same discipline
-- as accounts.claim_token_hash. A DB leak therefore yields nothing usable, and
-- the rows expire in 30 minutes anyway.
--
-- Multi-use within the TTL (no consumed flag): the developer reloads the reader
-- page, and a one-shot token would make a reload look like a bug. Expired rows
-- are swept opportunistically on the next mint — no background job (same
-- posture as SweepExpiredClaims).
CREATE TABLE feedback_reader_tokens (
    token_hash      BLOB    PRIMARY KEY,
    created_at_unix INTEGER NOT NULL,
    expires_at_unix INTEGER NOT NULL
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE feedback_reader_tokens;
-- +goose StatementEnd
