-- +goose Up
-- +goose StatementBegin
CREATE TRIGGER IF NOT EXISTS trg_change_timezone_history_ins AFTER INSERT ON timezone_history BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER IF NOT EXISTS trg_change_timezone_history_upd AFTER UPDATE ON timezone_history BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER IF NOT EXISTS trg_change_timezone_history_del AFTER DELETE ON timezone_history BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_timezone_history_ins;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_timezone_history_upd;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_timezone_history_del;
-- +goose StatementEnd
