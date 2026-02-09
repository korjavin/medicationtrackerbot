-- +goose Up
CREATE TABLE IF NOT EXISTS weight_reminder_state (
    user_id INTEGER PRIMARY KEY,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    snoozed_until DATETIME,
    dont_remind_until DATETIME,
    last_notification_sent_at DATETIME,
    notification_message_id INTEGER,
    preferred_reminder_hour INTEGER DEFAULT 9,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weight_reminder_enabled ON weight_reminder_state(enabled);
CREATE INDEX IF NOT EXISTS idx_weight_reminder_snoozed ON weight_reminder_state(snoozed_until);
CREATE INDEX IF NOT EXISTS idx_weight_reminder_dont_remind ON weight_reminder_state(dont_remind_until);

-- P1 FIX: Backfill existing users who have weight data
INSERT OR IGNORE INTO weight_reminder_state (user_id, enabled, preferred_reminder_hour)
SELECT DISTINCT user_id, 1, 9
FROM weight_logs;

-- +goose Down
DROP INDEX IF EXISTS idx_weight_reminder_dont_remind;
DROP INDEX IF EXISTS idx_weight_reminder_snoozed;
DROP INDEX IF EXISTS idx_weight_reminder_enabled;
DROP TABLE IF EXISTS weight_reminder_state;
