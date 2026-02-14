-- +goose Up
-- +goose StatementBegin
CREATE INDEX IF NOT EXISTS idx_workout_sessions_adhoc 
    ON workout_sessions(group_id) 
    WHERE group_id = -1;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_workout_sessions_adhoc;
-- +goose StatementEnd
