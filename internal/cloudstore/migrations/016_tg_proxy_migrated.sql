-- +goose Up
-- +goose StatementBegin
-- Per-bot flag: this bot's webhook + session live on the local Bot API proxy
-- (CLOUD_TG_API_BASE_URL), so getFile resolves the proxy-issued file_ids the bot
-- now delivers. file_ids are server-bound, so a bot minted on api.telegram.org
-- before the proxy was enabled must be migrated once — logOut on the cloud, then
-- re-setWebhook through the proxy (see `cloud admin migrate-bots-to-proxy`).
-- NULL = not on the proxy yet (pre-proxy bot needing migration, or proxy-disabled
-- deployment); a unix timestamp = migrated/created under the proxy. Bots linked
-- while the proxy is enabled are stamped at creation and never need migrating.
ALTER TABLE tg_bots ADD COLUMN proxy_migrated_at_unix INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE tg_bots DROP COLUMN proxy_migrated_at_unix;
-- +goose StatementEnd
