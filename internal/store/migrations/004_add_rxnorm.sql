-- +goose Up
ALTER TABLE medications ADD COLUMN rxcui TEXT;
ALTER TABLE medications ADD COLUMN normalized_name TEXT;

-- +goose Down
ALTER TABLE medications DROP COLUMN rxcui;
ALTER TABLE medications DROP COLUMN normalized_name;
