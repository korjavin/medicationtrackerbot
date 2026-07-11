-- +goose Up
-- +goose StatementBegin
-- Per-account allowlist of provider egress hostnames, driving the app
-- document's scoped connect-src CSP (docs/cloud-crypto.md → egress allowlist).
--
-- Stored as a JSON array of bare hostnames on the account row (NULL = none set
-- yet) rather than a child table: the list is tiny (capped at a handful),
-- always read/written whole, and naturally dies with the account — no join, no
-- accountKeyedTables entry. HOSTNAMES ONLY: never API keys, never health data.
-- The operator learns which provider host each account uses; the key + all
-- health data stay client-only/encrypted.
ALTER TABLE accounts ADD COLUMN egress_hosts TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE accounts DROP COLUMN egress_hosts;
-- +goose StatementEnd
