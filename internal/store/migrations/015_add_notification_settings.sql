-- +goose Up
CREATE TABLE notification_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    notification_type TEXT NOT NULL,
    enabled BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, notification_type)
);

CREATE INDEX idx_notification_settings_user ON notification_settings(user_id);
CREATE INDEX idx_notification_settings_enabled ON notification_settings(enabled, user_id);

-- Initialize settings for existing users with Telegram enabled by default
-- Get user_id from intake_log since medications table doesn't have user_id
INSERT INTO notification_settings (user_id, provider, notification_type, enabled)
SELECT DISTINCT user_id, 'telegram', 'medication', 1 FROM intake_log
UNION
SELECT DISTINCT user_id, 'telegram', 'workout', 1 FROM workout_sessions WHERE user_id IS NOT NULL
UNION
SELECT DISTINCT user_id, 'telegram', 'low_stock', 1 FROM blood_pressure_readings;

-- Enable web_push for users who already have push subscriptions
INSERT OR IGNORE INTO notification_settings (user_id, provider, notification_type, enabled)
SELECT DISTINCT user_id, 'web_push', 'medication', 1 FROM push_subscriptions WHERE enabled = 1
UNION
SELECT DISTINCT user_id, 'web_push', 'workout', 1 FROM push_subscriptions WHERE enabled = 1
UNION
SELECT DISTINCT user_id, 'web_push', 'low_stock', 1 FROM push_subscriptions WHERE enabled = 1;

-- +goose Down
DROP TABLE notification_settings;
