-- +goose Up
-- +goose StatementBegin
-- med-r3dm: an in-app terminal transition (dose confirm, workout complete/skip/
-- start) must delete the reminder message that is still live in the chat, not
-- just drop the pending re-fire. Until now the message_id a send produced only
-- survived as the NEXT re-fire's supersedes_message_id — which exists for med
-- chains but never for w:/bp:/wt: stems (scheduleMedRefire returns early on a
-- non-"s:" stem), so those ids were dropped on the floor after the primary send.
--
-- tg_message_id records the message_id the row's own Telegram send produced
-- (0 = web-push-only, or the send failed). Exactly like supersedes_message_id it
-- is a TG artifact the relay already holds — NEVER vault/ct data — so this stays
-- inside the zero-knowledge boundary. ScrubSentPushIdentity zeroes it on the same
-- 48h sweep that drops tg_callback/tg_med_ids, which is also Telegram's bot-delete
-- window: nothing outlives its deletability. DEFAULT 0 covers all pre-existing
-- rows and every untouched INSERT.
ALTER TABLE scheduled_pushes ADD COLUMN tg_message_id INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN tg_message_id;
-- +goose StatementEnd
