-- +goose Up
CREATE TABLE intake_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intake_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(intake_id) REFERENCES intake_log(id) ON DELETE CASCADE
);
CREATE INDEX idx_intake_reminders_intake_id ON intake_reminders(intake_id);

-- +goose Down
DROP INDEX idx_intake_reminders_intake_id;
DROP TABLE intake_reminders;
