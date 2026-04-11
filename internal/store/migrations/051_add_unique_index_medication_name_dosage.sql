-- +goose Up

-- Deduplicate existing rows before adding the unique constraint.
--
-- For each group of rows sharing the same (name COLLATE NOCASE, dosage),
-- keep the row with the smallest id unchanged and rename every other
-- row by appending ' (dup_<id>_<hex>)' where <id> is the row's primary
-- key and <hex> is 32 random hex characters from randomblob(16).
-- The 128-bit random suffix makes accidental collision with any
-- pre-existing row name negligible (p < 2^-128 per candidate pair).

UPDATE medications
SET name = name || ' (dup_' || id || '_' || lower(hex(randomblob(16))) || ')'
WHERE id NOT IN (
    SELECT MIN(id) FROM medications
    GROUP BY name COLLATE NOCASE, COALESCE(dosage, '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_medications_name_dosage
    ON medications(name COLLATE NOCASE, COALESCE(dosage, ''));

-- +goose Down
DROP INDEX IF EXISTS idx_medications_name_dosage;
