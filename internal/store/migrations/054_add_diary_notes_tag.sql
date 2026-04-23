-- +goose Up
-- +goose StatementBegin
ALTER TABLE diary_notes ADD COLUMN tag TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE diary_notes DROP COLUMN tag;
-- +goose StatementEnd
