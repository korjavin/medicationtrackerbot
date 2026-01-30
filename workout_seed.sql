-- Seed data for workout tracking
-- This creates the initial workout setup based on the Home Strength Program

-- IMPORTANT: Replace USER_ID_HERE with your actual Telegram user ID before running!

-- Morning Workouts Group (Non-rotating, Mon-Sat @ 09:00)
INSERT INTO workout_groups (name, description, is_rotating, user_id, days_of_week, scheduled_time, notification_advance_minutes)
VALUES ('Morning Workouts', 'Daily kettlebell swings', 0, USER_ID_HERE, '[1,2,3,4,5,6]', '09:00', 15);

-- Get the ID of the created group (will be 1 if this is the first workout group)
-- Create single variant for non-rotating group
INSERT INTO workout_variants (group_id, name, rotation_order, description)
VALUES (1, 'Default', NULL, 'Morning routine');

-- Add Kettlebell Swings exercise
INSERT INTO workout_exercises (variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
VALUES (1, 'Kettlebell Swings', 3, 15, 20, 30.0, 0);

-- Evening Main Group (Rotating, Mon/Wed/Fri/Sun @ 18:00)
INSERT INTO workout_groups (name, description, is_rotating, user_id, days_of_week, scheduled_time, notification_advance_minutes)
VALUES ('Evening Main', 'Rotating strength training', 1, USER_ID_HERE, '[1,3,5,0]', '18:00', 15);

-- Create 4 rotating variants (Day A, B, C, D)
INSERT INTO workout_variants (group_id, name, rotation_order, description) VALUES
(2, 'Day A', 0, 'Back focus - Barbell Rows'),
(2, 'Day B', 1, 'Chest focus - Bench Press'),
(2, 'Day C', 2, 'Posterior chain - Deadlift'),
(2, 'Day D', 3, 'Shoulders - Overhead Press');

-- Add exercises to each variant
-- Day A: Barbell Rows
INSERT INTO workout_exercises (variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
VALUES (2, 'Barbell Rows', 4, 8, 10, 40.0, 0);

-- Day B: Bench Press
INSERT INTO workout_exercises (variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
VALUES (3, 'Bench Press', 4, 8, 10, 40.0, 0);

-- Day C: Deadlift
INSERT INTO workout_exercises (variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
VALUES (4, 'Deadlift', 4, 8, 10, 45.0, 0);

-- Day D: Overhead Press
INSERT INTO workout_exercises (variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
VALUES (5, 'Overhead Press', 4, 6, 8, 30.0, 0);

-- Initialize rotation state (start with Day A - variant_id 2)
INSERT INTO workout_rotation_state (group_id, current_variant_id, last_session_date)
VALUES (2, 2, NULL);

-- Create initial schedule snapshot for Morning Workouts
INSERT INTO workout_schedule_snapshots (group_id, snapshot_data, change_reason)
VALUES (1, '{"name":"Morning Workouts","days_of_week":[1,2,3,4,5,6],"scheduled_time":"09:00","notification_advance_minutes":15}', 'Initial setup');

-- Create initial schedule snapshot for Evening Main
INSERT INTO workout_schedule_snapshots (group_id, snapshot_data, change_reason)
VALUES (2, '{"name":"Evening Main","days_of_week":[1,3,5,0],"scheduled_time":"18:00","notification_advance_minutes":15}', 'Initial setup');
