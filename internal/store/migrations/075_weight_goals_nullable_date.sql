-- +goose Up
-- +goose StatementBegin
-- sqlite doesn't support ALTER COLUMN to drop NOT NULL, so we rebuild the table.
-- Existing 0001-01-01 sentinels are converted to NULL.
CREATE TABLE weight_goals_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    set_at_unix     INTEGER NOT NULL,
    target_weight   REAL    NOT NULL,
    target_date     TEXT,
    start_weight    REAL
);

INSERT INTO weight_goals_new (id, user_id, set_at_unix, target_weight, target_date, start_weight)
SELECT id, user_id, set_at_unix, target_weight,
       CASE WHEN target_date = '0001-01-01' THEN NULL ELSE target_date END,
       start_weight
FROM weight_goals;

DROP TABLE weight_goals;
ALTER TABLE weight_goals_new RENAME TO weight_goals;
CREATE INDEX idx_weight_goals_user_set_at ON weight_goals(user_id, set_at_unix DESC);

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
CREATE TABLE weight_goals_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    set_at_unix     INTEGER NOT NULL,
    target_weight   REAL    NOT NULL,
    target_date     TEXT    NOT NULL DEFAULT '0001-01-01',
    start_weight    REAL
);

INSERT INTO weight_goals_new (id, user_id, set_at_unix, target_weight, target_date, start_weight)
SELECT id, user_id, set_at_unix, target_weight, coalesce(target_date, '0001-01-01'), start_weight
FROM weight_goals;

DROP TABLE weight_goals;
ALTER TABLE weight_goals_new RENAME TO weight_goals;
CREATE INDEX idx_weight_goals_user_set_at ON weight_goals(user_id, set_at_unix DESC);

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
