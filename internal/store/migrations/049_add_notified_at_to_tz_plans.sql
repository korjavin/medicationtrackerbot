-- +goose Up
-- +goose StatementBegin
ALTER TABLE tz_transition_plans ADD COLUMN notified_at DATETIME;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE tz_transition_plans DROP COLUMN notified_at;
-- +goose StatementEnd
