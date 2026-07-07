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
	"errors"
	"fmt"
	"strconv"
	"strings"
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

// GetBool reads a boolean settings column. SQLite stores booleans as integers,
// blobs, or actual bool depending on driver pathways, so this normalizes all
// three.
func (r *Repo) GetBool(ctx context.Context, column string) (bool, error) {
	var query string
	switch column {
	case "food_intake_enabled":
		query = "SELECT food_intake_enabled FROM settings WHERE id = 1"
	case "blood_pressure_enabled":
		query = "SELECT blood_pressure_enabled FROM settings WHERE id = 1"
	case "weight_enabled":
		query = "SELECT weight_enabled FROM settings WHERE id = 1"
	case "medication_enabled":
		query = "SELECT medication_enabled FROM settings WHERE id = 1"
	case "workout_enabled":
		query = "SELECT workout_enabled FROM settings WHERE id = 1"
	case "health_enabled":
		query = "SELECT health_enabled FROM settings WHERE id = 1"
	case "gamification_enabled":
		query = "SELECT gamification_enabled FROM settings WHERE id = 1"
	case "weekly_digest_enabled":
		query = "SELECT weekly_digest_enabled FROM settings WHERE id = 1"
	case "first_run_complete":
		query = "SELECT first_run_complete FROM settings WHERE id = 1"
	default:
		return false, fmt.Errorf("unknown settings column: %s", column)
	}

	var val interface{}
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
	var query string
	switch column {
	case "food_intake_enabled":
		query = "UPDATE settings SET food_intake_enabled = ? WHERE id = 1"
	case "blood_pressure_enabled":
		query = "UPDATE settings SET blood_pressure_enabled = ? WHERE id = 1"
	case "weight_enabled":
		query = "UPDATE settings SET weight_enabled = ? WHERE id = 1"
	case "medication_enabled":
		query = "UPDATE settings SET medication_enabled = ? WHERE id = 1"
	case "workout_enabled":
		query = "UPDATE settings SET workout_enabled = ? WHERE id = 1"
	case "health_enabled":
		query = "UPDATE settings SET health_enabled = ? WHERE id = 1"
	case "gamification_enabled":
		query = "UPDATE settings SET gamification_enabled = ? WHERE id = 1"
	case "weekly_digest_enabled":
		query = "UPDATE settings SET weekly_digest_enabled = ? WHERE id = 1"
	case "first_run_complete":
		query = "UPDATE settings SET first_run_complete = ? WHERE id = 1"
	default:
		return fmt.Errorf("unknown settings column: %s", column)
	}

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

// GetGamificationEnabled returns whether the gamification (HealthPoints / Rings
// / levels / streaks) layer is enabled. Default-ON: migration 073 adds the
// column with DEFAULT 1, so a freshly-migrated settings row reports true.
func (r *Repo) GetGamificationEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "gamification_enabled")
}

// SetGamificationEnabled toggles the gamification feature.
func (r *Repo) SetGamificationEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "gamification_enabled", enabled)
}

// GetWeeklyDigestEnabled returns whether the opt-in scheduled Sunday-evening
// bot digest is enabled. Default-OFF: migration 074 adds the column with
// DEFAULT 0, unlike most feature flags (gamification-12 Task 5).
func (r *Repo) GetWeeklyDigestEnabled(ctx context.Context) (bool, error) {
	return r.GetBool(ctx, "weekly_digest_enabled")
}

// SetWeeklyDigestEnabled toggles the scheduled weekly digest.
func (r *Repo) SetWeeklyDigestEnabled(ctx context.Context, enabled bool) error {
	return r.SetBool(ctx, "weekly_digest_enabled", enabled)
}

// GetWeeklyDigestLastSentAt returns when the scheduled digest last actually
// sent, or nil if it never has. The scheduler checker uses this to avoid
// resending within the same Sunday-evening hour window (it polls every 15
// min).
func (r *Repo) GetWeeklyDigestLastSentAt(ctx context.Context) (*time.Time, error) {
	var v sql.NullInt64
	if err := r.db.QueryRowContext(ctx, "SELECT weekly_digest_last_sent_at_unix FROM settings WHERE id = 1").Scan(&v); err != nil {
		return nil, err
	}
	if !v.Valid {
		return nil, nil
	}
	t := time.Unix(v.Int64, 0).UTC()
	return &t, nil
}

// SetWeeklyDigestLastSentAt records that the scheduled digest was just sent.
func (r *Repo) SetWeeklyDigestLastSentAt(ctx context.Context, sentAt time.Time) error {
	_, err := r.db.ExecContext(ctx, "UPDATE settings SET weekly_digest_last_sent_at_unix = ? WHERE id = 1", sentAt.UTC().Unix())
	return err
}

// GetFirstRunComplete reports whether the mobile first-run flow has been
// dismissed. Server installs are backfilled to true by migration 071 so the
// flow only fires for fresh mobile databases.
//
// If the singleton settings row is missing (a corner case on truly fresh
// mobile installs where the bootstrap migrations have run but the seed row
// was somehow rolled back), this method lazily inserts the row with
// first_run_complete=0 and returns (false, nil) so the firstrun overlay
// surfaces on first launch instead of being suppressed by the bootstrap
// handler's err→true fallback. The INSERT OR IGNORE makes the lazy-insert
// idempotent under concurrent first-time reads.
func (r *Repo) GetFirstRunComplete(ctx context.Context) (bool, error) {
	val, err := r.GetBool(ctx, "first_run_complete")
	if errors.Is(err, sql.ErrNoRows) {
		if _, insertErr := r.db.ExecContext(ctx, "INSERT OR IGNORE INTO settings (id, first_run_complete) VALUES (1, 0)"); insertErr != nil {
			return false, insertErr
		}
		return false, nil
	}
	return val, err
}

// SetFirstRunComplete records that the user has dismissed (or completed) the
// first-run flow. Idempotent: the firstrun endpoint may call this repeatedly.
func (r *Repo) SetFirstRunComplete(ctx context.Context, complete bool) error {
	return r.SetBool(ctx, "first_run_complete", complete)
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

// GetDismissedTZSuggestion returns the IANA timezone string the user most
// recently dismissed when prompted to change timezones (cross-client suppression
// signal so a dismissal in one browser silences other clients until the
// detected TZ changes). Empty string means no dismissal is on record.
func (r *Repo) GetDismissedTZSuggestion(ctx context.Context) (string, error) {
	var tz sql.NullString
	err := r.db.QueryRowContext(ctx, "SELECT dismissed_tz_suggestion FROM settings WHERE id = 1").Scan(&tz)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if tz.Valid {
		return tz.String, nil
	}
	return "", nil
}

// SetDismissedTZSuggestion records the IANA timezone the user dismissed.
func (r *Repo) SetDismissedTZSuggestion(ctx context.Context, tz string) error {
	_, err := r.db.ExecContext(ctx, "UPDATE settings SET dismissed_tz_suggestion = ? WHERE id = 1", tz)
	return err
}

// IntegrationOpenAI is the settings-table-backed view of the OpenAI provider
// configuration. The settings repo intentionally defines its own DTOs (rather
// than reusing internal/config types) so internal/config can depend on
// internal/store/settings via LoadFromSettings without a cyclic import.
type IntegrationOpenAI struct {
	APIKey       string
	URL          string
	Model        string
	VisionAPIKey string
	VisionURL    string
	VisionModel  string
}

// IntegrationFood is the settings-table-backed view of the remote food-DB
// lookup credentials.
type IntegrationFood struct {
	APIKey string
	URL    string
}

// IntegrationElevenLabs is the settings-table-backed view of the Voice Agent
// proxy credentials.
type IntegrationElevenLabs struct {
	APIKey  string
	AgentID string
}

// GetIntegrationOpenAI reads the OpenAI provider config columns from the
// singleton settings row.
func (r *Repo) GetIntegrationOpenAI(ctx context.Context) (IntegrationOpenAI, error) {
	var v IntegrationOpenAI
	err := r.db.QueryRowContext(ctx, `SELECT
		openai_api_key, openai_url, openai_model,
		openai_vision_api_key, openai_vision_url, openai_vision_model
		FROM settings WHERE id = 1`).Scan(
		&v.APIKey, &v.URL, &v.Model,
		&v.VisionAPIKey, &v.VisionURL, &v.VisionModel,
	)
	if err == sql.ErrNoRows {
		return IntegrationOpenAI{}, nil
	}
	return v, err
}

// SetIntegrationOpenAI writes all OpenAI provider config columns in one
// statement. Empty strings clear the column (a "" override is the explicit way
// to unset a previously-saved value).
func (r *Repo) SetIntegrationOpenAI(ctx context.Context, v IntegrationOpenAI) error {
	_, err := r.db.ExecContext(ctx, `UPDATE settings SET
		openai_api_key = ?, openai_url = ?, openai_model = ?,
		openai_vision_api_key = ?, openai_vision_url = ?, openai_vision_model = ?
		WHERE id = 1`,
		v.APIKey, v.URL, v.Model,
		v.VisionAPIKey, v.VisionURL, v.VisionModel,
	)
	return err
}

// GetIntegrationFood reads the remote food-DB lookup columns from the
// singleton settings row.
func (r *Repo) GetIntegrationFood(ctx context.Context) (IntegrationFood, error) {
	var v IntegrationFood
	err := r.db.QueryRowContext(ctx, `SELECT food_api_key, food_url
		FROM settings WHERE id = 1`).Scan(&v.APIKey, &v.URL)
	if err == sql.ErrNoRows {
		return IntegrationFood{}, nil
	}
	return v, err
}

// SetIntegrationFood writes all remote food-DB lookup columns in one statement.
func (r *Repo) SetIntegrationFood(ctx context.Context, v IntegrationFood) error {
	_, err := r.db.ExecContext(ctx, `UPDATE settings SET
		food_api_key = ?, food_url = ?
		WHERE id = 1`, v.APIKey, v.URL)
	return err
}

// GetIntegrationElevenLabs reads the Voice Agent proxy credentials from the
// singleton settings row.
func (r *Repo) GetIntegrationElevenLabs(ctx context.Context) (IntegrationElevenLabs, error) {
	var v IntegrationElevenLabs
	err := r.db.QueryRowContext(ctx, `SELECT elevenlabs_api_key, elevenlabs_agent_id
		FROM settings WHERE id = 1`).Scan(&v.APIKey, &v.AgentID)
	if err == sql.ErrNoRows {
		return IntegrationElevenLabs{}, nil
	}
	return v, err
}

// SetIntegrationElevenLabs writes the Voice Agent proxy credentials.
func (r *Repo) SetIntegrationElevenLabs(ctx context.Context, v IntegrationElevenLabs) error {
	_, err := r.db.ExecContext(ctx, `UPDATE settings SET
		elevenlabs_api_key = ?, elevenlabs_agent_id = ? WHERE id = 1`,
		v.APIKey, v.AgentID)
	return err
}

// IntegrationOpenAIPatch is a partial update for the OpenAI integration row.
// nil field = leave the column unchanged; non-nil = overwrite with *value
// (including empty string, which explicitly clears the column).
type IntegrationOpenAIPatch struct {
	APIKey       *string
	URL          *string
	Model        *string
	VisionAPIKey *string
	VisionURL    *string
	VisionModel  *string
}

// IntegrationFoodPatch is the partial-update counterpart of IntegrationFood.
type IntegrationFoodPatch struct {
	APIKey *string
	URL    *string
}

// IntegrationElevenLabsPatch is the partial-update counterpart of
// IntegrationElevenLabs.
type IntegrationElevenLabsPatch struct {
	APIKey  *string
	AgentID *string
}

// PatchIntegrations applies partial updates to the OpenAI / Food / ElevenLabs
// integration columns atomically. Each patch pointer is nil to skip the group;
// within a group, each field is nil to leave its column unchanged. Only
// explicitly-set columns are written, so concurrent partial patches that touch
// disjoint fields cannot clobber each other and a stale read can never resurrect
// a column another patch just cleared.
func (r *Repo) PatchIntegrations(ctx context.Context, openAI *IntegrationOpenAIPatch, food *IntegrationFoodPatch, el *IntegrationElevenLabsPatch) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		if openAI != nil {
			sets, args := openAI.sqlSet()
			if err := execPatch(ctx, tx, sets, args); err != nil {
				return err
			}
		}
		if food != nil {
			sets, args := food.sqlSet()
			if err := execPatch(ctx, tx, sets, args); err != nil {
				return err
			}
		}
		if el != nil {
			sets, args := el.sqlSet()
			if err := execPatch(ctx, tx, sets, args); err != nil {
				return err
			}
		}
		return nil
	})
}

// execPatch runs a singleton-row UPDATE against the settings table, skipping
// the call entirely when no columns are being set. Column names come from
// hardcoded literals in the sqlSet helpers, never user input, so concatenation
// here is safe.
func execPatch(ctx context.Context, tx storedb.TX, sets []string, args []any) error {
	if len(sets) == 0 {
		return nil
	}
	query := "UPDATE settings SET " + strings.Join(sets, ", ") + " WHERE id = 1" // #nosec G201 -- column names are hardcoded literals
	_, err := tx.ExecContext(ctx, query, args...)
	return err
}

func (p *IntegrationOpenAIPatch) sqlSet() ([]string, []any) {
	sets := make([]string, 0, 6)
	args := make([]any, 0, 6)
	if p.APIKey != nil {
		sets = append(sets, "openai_api_key = ?")
		args = append(args, *p.APIKey)
	}
	if p.URL != nil {
		sets = append(sets, "openai_url = ?")
		args = append(args, *p.URL)
	}
	if p.Model != nil {
		sets = append(sets, "openai_model = ?")
		args = append(args, *p.Model)
	}
	if p.VisionAPIKey != nil {
		sets = append(sets, "openai_vision_api_key = ?")
		args = append(args, *p.VisionAPIKey)
	}
	if p.VisionURL != nil {
		sets = append(sets, "openai_vision_url = ?")
		args = append(args, *p.VisionURL)
	}
	if p.VisionModel != nil {
		sets = append(sets, "openai_vision_model = ?")
		args = append(args, *p.VisionModel)
	}
	return sets, args
}

func (p *IntegrationFoodPatch) sqlSet() ([]string, []any) {
	sets := make([]string, 0, 2)
	args := make([]any, 0, 2)
	if p.APIKey != nil {
		sets = append(sets, "food_api_key = ?")
		args = append(args, *p.APIKey)
	}
	if p.URL != nil {
		sets = append(sets, "food_url = ?")
		args = append(args, *p.URL)
	}
	return sets, args
}

func (p *IntegrationElevenLabsPatch) sqlSet() ([]string, []any) {
	sets := make([]string, 0, 2)
	args := make([]any, 0, 2)
	if p.APIKey != nil {
		sets = append(sets, "elevenlabs_api_key = ?")
		args = append(args, *p.APIKey)
	}
	if p.AgentID != nil {
		sets = append(sets, "elevenlabs_agent_id = ?")
		args = append(args, *p.AgentID)
	}
	return sets, args
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
// ListChangedTagsSince on the next poll.
func (r *Repo) GetLatestChangeCursor(ctx context.Context) (int64, error) {
	var cursor int64
	if err := r.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id), 0) FROM change_events").Scan(&cursor); err != nil {
		return 0, err
	}
	return cursor, nil
}

// ListChangedTagsSince returns the new cursor and the distinct tags whose
// change_events have ids strictly greater than `since`. Tags are returned in
// ascending order. The cursor is the latest id at the moment of the call —
// callers should treat it as opaque and pass it back on the next call.
func (r *Repo) ListChangedTagsSince(ctx context.Context, since int64) (int64, []string, error) {
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
