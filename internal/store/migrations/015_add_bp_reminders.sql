-- +goose Up
-- BP reminder state table
CREATE TABLE IF NOT EXISTS bp_reminder_state (
    user_id INTEGER PRIMARY KEY,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    snoozed_until DATETIME,
    dont_remind_until DATETIME,
    last_notification_sent_at DATETIME,
    notification_message_id INTEGER,
    preferred_reminder_hour INTEGER DEFAULT 20,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for scheduler queries
CREATE INDEX IF NOT EXISTS idx_bp_reminder_enabled ON bp_reminder_state(enabled);
CREATE INDEX IF NOT EXISTS idx_bp_reminder_snoozed ON bp_reminder_state(snoozed_until);
CREATE INDEX IF NOT EXISTS idx_bp_reminder_dont_remind ON bp_reminder_state(dont_remind_until);

-- +goose Down
DROP INDEX IF EXISTS idx_bp_reminder_dont_remind;
DROP INDEX IF EXISTS idx_bp_reminder_snoozed;
DROP INDEX IF EXISTS idx_bp_reminder_enabled;
DROP TABLE IF EXISTS bp_reminder_state;
