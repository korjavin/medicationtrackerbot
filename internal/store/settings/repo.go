// Package settings owns the singleton-row settings table (per-feature toggles,
// tab order, last-download timestamp) and the change_events stream consumed by
// the offline-sync layer to discover which tags need a refetch.
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.Settings; new code should depend on *settings.Repo (or a
// narrow interface satisfied by it) directly.
package settings

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Repo is the settings + change_events repository. Construct with New; share
// one *Repo per process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db *storedb.DB
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d}
}

// allowedBoolColumns is the allowlist of valid boolean column names in the
// settings table. Any column referenced by GetBool / SetBool must appear here;
// the SQL string is built with fmt.Sprintf, so this allowlist is the SQL
// injection guard.
var allowedBoolColumns = map[string]bool{
	"food_intake_enabled":    true,
	"blood_pressure_enabled": true,
	"weight_enabled":         true,
	"medication_enabled":     true,
	"workout_enabled":        true,
	"health_enabled":         true,
}

// GetBool reads a boolean settings column. SQLite stores booleans as integers,
// blobs, or actual bool depending on driver pathways, so this normalizes all
// three.
func (r *Repo) GetBool(ctx context.Context, column string) (bool, error) {
	if !allowedBoolColumns[column] {
		return false, fmt.Errorf("unknown settings column: %s", column)
	}
	var val interface{}
	query := fmt.Sprintf("SELECT %s FROM settings WHERE id = 1", column) // #nosec G201 -- column validated against allowlist above
	if err := r.db.QueryRowContext(ctx, query).Scan(&val); err != nil {
		return false, err
	}

	switch v := val.(type) {
	case int64:
		return v == 1, nil
	case bool:
		return v, nil
	case []uint8:
		return len(v) > 0 && v[0] == 1, nil
	default:
		return false, nil
	}
}

// SetBool writes a boolean settings column.
func (r *Repo) SetBool(ctx context.Context, column string, enabled bool) error {
	if !allowedBoolColumns[column] {
		return fmt.Errorf("unknown settings column: %s", column)
	}
	query := fmt.Sprintf("UPDATE settings SET %s = ? WHERE id = 1", column) // #nosec G201 -- column validated against allowlist above
	_, err := r.db.ExecContext(ctx, query, enabled)
	return err
}

// GetFoodIntakeEnabled returns whether food intake tracking is enabled.
func (r *Repo) GetFoodIntakeEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "food_intake_enabled")
}

// SetFoodIntakeEnabled toggles the food intake feature.
func (r *Repo) SetFoodIntakeEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "food_intake_enabled", enabled)
}

// GetBloodPressureEnabled returns whether blood pressure tracking is enabled.
func (r *Repo) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "blood_pressure_enabled")
}

// SetBloodPressureEnabled toggles the blood pressure feature.
func (r *Repo) SetBloodPressureEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "blood_pressure_enabled", enabled)
}

// GetWeightEnabled returns whether weight tracking is enabled.
func (r *Repo) GetWeightEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "weight_enabled")
}

// SetWeightEnabled toggles the weight feature.
func (r *Repo) SetWeightEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "weight_enabled", enabled)
}

// GetMedicationEnabled returns whether medication tracking is enabled.
func (r *Repo) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "medication_enabled")
}

// SetMedicationEnabled toggles the medication feature.
func (r *Repo) SetMedicationEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "medication_enabled", enabled)
}

// GetWorkoutEnabled returns whether workout tracking is enabled.
func (r *Repo) GetWorkoutEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "workout_enabled")
}

// SetWorkoutEnabled toggles the workout feature.
func (r *Repo) SetWorkoutEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "workout_enabled", enabled)
}

// GetHealthEnabled returns whether vitals/health tracking is enabled.
func (r *Repo) GetHealthEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "health_enabled")
}

// SetHealthEnabled toggles the vitals/health feature.
func (r *Repo) SetHealthEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "health_enabled", enabled)
}

// GetTabOrder returns the user's preferred tab order as a JSON string. An
// empty string means no preference has been recorded.
func (r *Repo) GetTabOrder(ctx context.Context) (string, error) {
	var tabOrder sql.NullString
	err := r.db.QueryRowContext(ctx, "SELECT tab_order FROM settings WHERE id = 1").Scan(&tabOrder)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if tabOrder.Valid {
		return tabOrder.String, nil
	}
	return "", nil
}

// SetTabOrder writes the user's preferred tab order as a JSON string.
func (r *Repo) SetTabOrder(ctx context.Context, order string) error {
	_, err := r.db.ExecContext(ctx, "UPDATE settings SET tab_order = ? WHERE id = 1", order)
	return err
}

// GetLastDownload returns the timestamp of the last drug-database download,
// or the zero time if nothing has ever been downloaded.
func (r *Repo) GetLastDownload() (time.Time, error) {
	var lastDownload time.Time
	err := r.db.QueryRow("SELECT last_download FROM settings WHERE id = 1").Scan(&lastDownload)
	if err == sql.ErrNoRows {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return lastDownload, nil
}

// UpdateLastDownload records the timestamp of the most recent successful
// drug-database download.
func (r *Repo) UpdateLastDownload(t time.Time) error {
	_, err := r.db.Exec("UPDATE settings SET last_download = ? WHERE id = 1", t)
	return err
}

// GetLatestChangeCursor returns the highest change_events.id, or 0 when the
// stream is empty. Callers use this as the cursor they pass back to
// GetChangedTagsSince on the next poll.
func (r *Repo) GetLatestChangeCursor(ctx context.Context) (int64, error) {
	var cursor int64
	if err := r.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id), 0) FROM change_events").Scan(&cursor); err != nil {
		return 0, err
	}
	return cursor, nil
}

// GetChangedTagsSince returns the new cursor and the distinct tags whose
// change_events have ids strictly greater than `since`. Tags are returned in
// ascending order. The cursor is the latest id at the moment of the call —
// callers should treat it as opaque and pass it back on the next call.
func (r *Repo) GetChangedTagsSince(ctx context.Context, since int64) (int64, []string, error) {
	cursor, err := r.GetLatestChangeCursor(ctx)
	if err != nil {
		return 0, nil, err
	}

	rows, err := r.db.QueryContext(ctx, "SELECT DISTINCT tag FROM change_events WHERE id > ? ORDER BY tag ASC", since)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	tags := make([]string, 0, 8)
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return 0, nil, err
		}
		tags = append(tags, tag)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}

	return cursor, tags, nil
}

// PruneChangeEvents removes old and excessive change events.
// keepLast: keep at least this many latest rows (0 disables count-based pruning).
// maxAgeDays: delete rows older than this many days (0 disables age-based pruning).
func (r *Repo) PruneChangeEvents(ctx context.Context, keepLast, maxAgeDays int) error {
	if maxAgeDays > 0 {
		if _, err := r.db.ExecContext(ctx, "DELETE FROM change_events WHERE created_at < datetime('now', ?)", "-"+strconv.Itoa(maxAgeDays)+" days"); err != nil {
			return err
		}
	}

	if keepLast > 0 {
		if _, err := r.db.ExecContext(ctx, `
			DELETE FROM change_events
			WHERE id < COALESCE((
				SELECT MIN(id) FROM (
					SELECT id
					FROM change_events
					ORDER BY id DESC
					LIMIT ?
				)
			), 0)
		`, keepLast); err != nil {
			return err
		}
	}

	return nil
}
