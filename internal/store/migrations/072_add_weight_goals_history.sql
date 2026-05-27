-- +goose Up
-- +goose StatementBegin
-- Append-only per-user history of weight goal commitments. Each row captures
-- a single SetGoal call: the moment the goal was saved (set_at_unix), the
-- target (target_weight, target_date), and a snapshot of the user's weight at
-- that moment (start_weight, nullable when no prior log exists). The latest
-- row per user IS the "current goal" — see internal/store/weight/repo.go's
-- GetGoal which reads from here first, falling back to the legacy
-- settings.weight_goal{,_date} singleton when this table is empty for a user.
--
-- The chart uses (set_at_unix, start_weight) → (target_date, target_weight)
-- as the trajectory endpoints. Without this snapshot, moving only the goal
-- date produces no visible chart change — the bug this migration unblocks.
--
-- Legacy settings.weight_goal{,_date} columns are NOT migrated here: the
-- singleton row doesn't carry user_id, and "weight when I committed" is
-- unknowable retroactively. Old goals continue to render via the chart's
-- fallback path until the user saves the next goal.
CREATE TABLE weight_goals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    set_at_unix     INTEGER NOT NULL,
    target_weight   REAL    NOT NULL,
    target_date     TEXT    NOT NULL,
    start_weight    REAL
);
CREATE INDEX idx_weight_goals_user_set_at ON weight_goals(user_id, set_at_unix DESC);
-- weight_goals changes propagate under the 'weight' tag so cross-channel
-- writes (bot, MCP) reach web subscribers through change_events the same way
-- weight_logs do (see migration 027). The dual-write to settings still fires
-- the 'settings' trigger, but the chart subscribes to 'weight'.
CREATE TRIGGER trg_change_weight_goals_ins AFTER INSERT ON weight_goals BEGIN
    INSERT INTO change_events(tag) VALUES ('weight');
END;
CREATE TRIGGER trg_change_weight_goals_upd AFTER UPDATE ON weight_goals BEGIN
    INSERT INTO change_events(tag) VALUES ('weight');
END;
CREATE TRIGGER trg_change_weight_goals_del AFTER DELETE ON weight_goals BEGIN
    INSERT INTO change_events(tag) VALUES ('weight');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_weight_goals_del;
DROP TRIGGER IF EXISTS trg_change_weight_goals_upd;
DROP TRIGGER IF EXISTS trg_change_weight_goals_ins;
DROP INDEX IF EXISTS idx_weight_goals_user_set_at;
DROP TABLE IF EXISTS weight_goals;
-- +goose StatementEnd
