-- Migration 017: Support ad-hoc workouts by allowing group_id and variant_id to be -1
-- Ad-hoc workouts use -1 as a sentinel value for both group_id and variant_id

-- Add index for efficiently querying ad-hoc sessions
CREATE INDEX IF NOT EXISTS idx_workout_sessions_adhoc ON workout_sessions(group_id) WHERE group_id = -1;

-- Add comment explaining the ad-hoc pattern
-- Ad-hoc workouts are identified by group_id = -1 and variant_id = -1
-- These represent unscheduled workouts that users can start at any time
