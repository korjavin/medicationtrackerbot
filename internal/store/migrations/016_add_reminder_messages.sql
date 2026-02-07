-- +goose Up
-- Migration 016: Add reminder_messages table
-- Tracks reminder message IDs per provider so they can be cleared when medication is confirmed

CREATE TABLE IF NOT EXISTS reminder_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    intake_id INTEGER NOT NULL,
    provider TEXT NOT NULL,           -- 'telegram', 'web_push', etc.
    message_id TEXT NOT NULL,          -- Provider-specific message ID
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (intake_id) REFERENCES intake_log(id) ON DELETE CASCADE
);

CREATE INDEX idx_reminder_messages_intake ON reminder_messages(intake_id);
CREATE INDEX idx_reminder_messages_user_provider ON reminder_messages(user_id, provider);

-- +goose Down
DROP TABLE reminder_messages;
