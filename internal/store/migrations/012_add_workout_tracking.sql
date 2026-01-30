-- +goose Up
CREATE TABLE IF NOT EXISTS workout_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_rotating BOOLEAN DEFAULT 0,
    user_id INTEGER NOT NULL,
    days_of_week TEXT NOT NULL, -- JSON array: [1,2,3,4,5,6]
    scheduled_time TEXT NOT NULL, -- HH:MM
    notification_advance_minutes INTEGER DEFAULT 15,
    active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workout_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    rotation_order INTEGER, -- 0,1,2,3 for rotating; NULL for non-rotating
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(group_id) REFERENCES workout_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workout_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id INTEGER NOT NULL,
    exercise_name TEXT NOT NULL,
    target_sets INTEGER NOT NULL,
    target_reps_min INTEGER NOT NULL,
    target_reps_max INTEGER,
    target_weight_kg DECIMAL,
    order_index INTEGER DEFAULT 0,
    FOREIGN KEY(variant_id) REFERENCES workout_variants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workout_schedule_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    snapshot_data TEXT NOT NULL, -- JSON
    change_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(group_id) REFERENCES workout_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workout_rotation_state (
    group_id INTEGER PRIMARY KEY,
    current_variant_id INTEGER NOT NULL,
    last_session_date DATE,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(group_id) REFERENCES workout_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(current_variant_id) REFERENCES workout_variants(id)
);

CREATE TABLE IF NOT EXISTS workout_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    variant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    scheduled_date DATE NOT NULL,
    scheduled_time TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, notified, in_progress, completed, skipped
    started_at DATETIME,
    completed_at DATETIME,
    snoozed_until DATETIME,
    snooze_count INTEGER DEFAULT 0,
    notification_message_id INTEGER,
    notes TEXT,
    FOREIGN KEY(group_id) REFERENCES workout_groups(id),
    FOREIGN KEY(variant_id) REFERENCES workout_variants(id)
);

CREATE TABLE IF NOT EXISTS workout_exercise_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL,
    exercise_name TEXT NOT NULL,
    sets_completed INTEGER,
    reps_completed INTEGER,
    weight_kg DECIMAL,
    status TEXT DEFAULT 'completed', -- completed, skipped
    notes TEXT,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES workout_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(exercise_id) REFERENCES workout_exercises(id)
);

CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_date ON workout_sessions(user_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_status ON workout_sessions(status);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_snoozed ON workout_sessions(snoozed_until);
CREATE INDEX IF NOT EXISTS idx_workout_exercise_logs_session ON workout_exercise_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_workout_variants_group ON workout_variants(group_id);

-- +goose Down
DROP TABLE IF EXISTS workout_exercise_logs;
DROP TABLE IF EXISTS workout_sessions;
DROP TABLE IF EXISTS workout_rotation_state;
DROP TABLE IF EXISTS workout_schedule_snapshots;
DROP TABLE IF EXISTS workout_exercises;
DROP TABLE IF EXISTS workout_variants;
DROP TABLE IF EXISTS workout_groups;
