-- +goose Up
-- Convert existing simple "HH:MM" schedules to JSON format {"type":"daily", "times":["HH:MM"]}
-- We use a simple SQLite trick: if it doesn't start with '{', treat it as legacy string using string concatenation.
UPDATE medications
SET schedule = '{"type":"daily","times":["' || schedule || '"]}'
WHERE schedule NOT LIKE '{%';

-- +goose Down
-- Reverting is hard because we might loose data if it was complex. 
-- Best effort: extract first time if type is daily. 
-- Actually, let's just leave it as is for Down since old code might break on JSON but we don't expect to rollback often.
-- Or we can try to extract:
-- UPDATE medications SET schedule = json_extract(schedule, '$.times[0]') WHERE json_extract(schedule, '$.type') = 'daily';
