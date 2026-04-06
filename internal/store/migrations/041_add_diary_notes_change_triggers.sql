-- +goose Up
-- +goose StatementBegin
CREATE TRIGGER IF NOT EXISTS trg_change_diary_notes_ins AFTER INSERT ON diary_notes BEGIN
    INSERT INTO change_events(tag) VALUES ('notes');
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER IF NOT EXISTS trg_change_diary_notes_del AFTER DELETE ON diary_notes BEGIN
    INSERT INTO change_events(tag) VALUES ('notes');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_diary_notes_ins;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_diary_notes_del;
-- +goose StatementEnd
