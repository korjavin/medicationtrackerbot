-- +goose Up
CREATE UNIQUE INDEX IF NOT EXISTS idx_tz_plans_hash_active
ON tz_transition_plans(plan_hash)
WHERE status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED');

-- +goose Down
DROP INDEX IF EXISTS idx_tz_plans_hash_active;
