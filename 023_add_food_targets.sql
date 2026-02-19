-- +goose Up
ALTER TABLE settings ADD COLUMN food_target_calories INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN food_target_carbs INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN food_target_protein INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN food_target_fat INTEGER DEFAULT 0;
