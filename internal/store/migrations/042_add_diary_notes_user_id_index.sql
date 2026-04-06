-- +goose Up
-- +goose StatementBegin
CREATE INDEX IF NOT EXISTS idx_diary_notes_user_id ON diary_notes(user_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_diary_notes_user_id;
-- +goose StatementEnd
