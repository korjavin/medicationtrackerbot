-- +goose Up
CREATE TABLE IF NOT EXISTS medications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dosage TEXT,
    schedule TEXT, -- JSON or Cron string
    archived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS intake_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medication_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, -- To double check owner
    scheduled_at DATETIME NOT NULL,
    taken_at DATETIME,
    status TEXT DEFAULT 'PENDING', -- PENDING, TAKEN, MISSED
    FOREIGN KEY(medication_id) REFERENCES medications(id)
);

CREATE INDEX IF NOT EXISTS idx_intake_log_scheduled_at ON intake_log(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_intake_log_status ON intake_log(status);


-- +goose Up
ALTER TABLE medications ADD COLUMN start_date DATETIME;
ALTER TABLE medications ADD COLUMN end_date DATETIME;

