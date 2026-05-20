-- +goose Up
-- Add user-configurable integration config columns to the singleton settings
-- table. These shadow env-var equivalents (OPENAI_*, FOOD_*, ELEVENLABS_*) so
-- the upcoming mobile build can read them from the database when env vars are
-- absent; on server installs, env vars still win via config.Merge.
ALTER TABLE settings ADD COLUMN openai_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN openai_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN openai_model TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN openai_vision_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN openai_vision_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN openai_vision_model TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN food_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN food_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN food_domain TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN elevenlabs_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN elevenlabs_agent_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE settings DROP COLUMN elevenlabs_agent_id;
ALTER TABLE settings DROP COLUMN elevenlabs_api_key;
ALTER TABLE settings DROP COLUMN food_domain;
ALTER TABLE settings DROP COLUMN food_url;
ALTER TABLE settings DROP COLUMN food_api_key;
ALTER TABLE settings DROP COLUMN openai_vision_model;
ALTER TABLE settings DROP COLUMN openai_vision_url;
ALTER TABLE settings DROP COLUMN openai_vision_api_key;
ALTER TABLE settings DROP COLUMN openai_model;
ALTER TABLE settings DROP COLUMN openai_url;
ALTER TABLE settings DROP COLUMN openai_api_key;
