-- +goose Up
ALTER TABLE settings ADD COLUMN blood_pressure_enabled BOOLEAN DEFAULT 1;
ALTER TABLE settings ADD COLUMN weight_enabled BOOLEAN DEFAULT 1;
ALTER TABLE settings ADD COLUMN medication_enabled BOOLEAN DEFAULT 1;
ALTER TABLE settings ADD COLUMN workout_enabled BOOLEAN DEFAULT 1;

-- +goose Down
ALTER TABLE settings DROP COLUMN workout_enabled;
ALTER TABLE settings DROP COLUMN medication_enabled;
ALTER TABLE settings DROP COLUMN weight_enabled;
ALTER TABLE settings DROP COLUMN blood_pressure_enabled;
