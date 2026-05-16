// Package tz owns the timezone_history and tz_transition_plans tables: the
// user's stored timezone (with history) and pending/approved/rejected
// DST-style transition plans (created when the user changes timezones).
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.TZ; new code should depend on *tz.Repo (or a narrow
// interface satisfied by it) directly.
//
// Track D Task 13 dropped the tz_transition_steps table; the per-medication
// dose-shift steps for each plan now live as PENDING source='tz_step' rows in
// intake_log (pre-materialized at approve time via
// medication.MaterializePlanStepsAsIntakesTx, which reads from
// tz_transition_plans.steps_json — the audit blob of the original step list).
//
// RejectTZTransitionPlanAndRevertTimezone and CreateTZTransitionPlanWithSteps
// are intra-package transactions: rejection writes timezone_history under the
// same tx as the plan update, and plan-with-steps cancels any active plan plus
// inserts the new one (and deletes orphaned pre-materialized intake rows) in
// one tx.
package tz

import (
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// TZTransitionPlan represents a pending or completed timezone transition plan.
type TZTransitionPlan struct {
	ID         int64      `json:"id"`
	OldTZ      string     `json:"old_tz"`
	NewTZ      string     `json:"new_tz"`
	CreatedAt  time.Time  `json:"created_at"`
	Status     string     `json:"status"` // PENDING_APPROVAL / NOTIFIED / APPROVED / REJECTED / CANCELLED / EXPIRED
	StepsJSON  string     `json:"steps_json"`
	InputsJSON string     `json:"inputs_json"`
	PlanHash   string     `json:"plan_hash"`
	NotifiedAt *time.Time `json:"notified_at,omitempty"`
	ApprovedAt *time.Time `json:"approved_at,omitempty"`
	UserAction string     `json:"user_action,omitempty"`
}

// Repo is the timezone-and-transition-plan repository. Construct with New;
// share one *Repo per process — the underlying *db.DB owns its own connection
// pool.
type Repo struct {
	db *storedb.DB
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d}
}

// GetCurrentTimezone returns the most recently recorded timezone, or "" if
// the table is empty.
func (r *Repo) GetCurrentTimezone() (string, error) {
	var tz string
	err := r.db.QueryRow(`SELECT timezone FROM timezone_history ORDER BY recorded_at DESC, id DESC LIMIT 1`).Scan(&tz)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return tz, nil
}

// RecordTimezone appends the new timezone to timezone_history only if it differs
// from the current active timezone. This prevents unbounded table growth when the
// frontend calls the endpoint on every startup.
//
// When the timezone actually changes, the dismissed_tz_suggestion flag in the
// singleton settings row is cleared in the same transaction so a future
// detection that *also* differs from this new stored TZ prompts again
// (the dismissal is for a specific detected TZ, not a permanent silence).
func (r *Repo) RecordTimezone(tz string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.Exec(`
		INSERT INTO timezone_history (timezone)
		SELECT ?
		WHERE COALESCE(
			(SELECT timezone FROM timezone_history ORDER BY recorded_at DESC, id DESC LIMIT 1),
			'') != ?`, tz, tz)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		if _, err = tx.Exec(`UPDATE settings SET dismissed_tz_suggestion = '' WHERE id = 1`); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// -- TZ Transition Plans --

// CreateTZTransitionPlan saves a new timezone transition plan and returns its ID.
// created_at_unix is stamped at the SQL layer via the column default
// (strftime('%s','now')), matching the prior CURRENT_TIMESTAMP behaviour for
// the legacy DATETIME column.
func (r *Repo) CreateTZTransitionPlan(plan *TZTransitionPlan) (int64, error) {
	res, err := r.db.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		plan.OldTZ, plan.NewTZ, plan.Status, plan.StepsJSON, plan.InputsJSON, plan.PlanHash,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// scanPlan scans the standard column list — id, old_tz, new_tz, created_at_unix,
// status, steps_json, inputs_json, plan_hash, notified_at_unix, approved_at_unix,
// user_action — into a TZTransitionPlan. Reads convert INTEGER unix-seconds-UTC
// to time.Time via storedb.UnixToTime so the public field shape (time.Time)
// stays the same.
func scanPlan(scan func(...interface{}) error) (*TZTransitionPlan, error) {
	var p TZTransitionPlan
	var createdAtUnix int64
	var notifiedAtUnix, approvedAtUnix sql.NullInt64
	var userAction sql.NullString
	if err := scan(&p.ID, &p.OldTZ, &p.NewTZ, &createdAtUnix, &p.Status, &p.StepsJSON, &p.InputsJSON, &p.PlanHash, &notifiedAtUnix, &approvedAtUnix, &userAction); err != nil {
		return nil, err
	}
	p.CreatedAt = storedb.UnixToTime(createdAtUnix)
	p.NotifiedAt = storedb.NullableUnixToTimePtr(notifiedAtUnix)
	p.ApprovedAt = storedb.NullableUnixToTimePtr(approvedAtUnix)
	if userAction.Valid {
		p.UserAction = userAction.String
	}
	return &p, nil
}

const planSelectCols = `id, old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash, notified_at_unix, approved_at_unix, user_action`

// GetLatestCompletedTZTransitionPlan returns the most recent plan in
// COMPLETED status, or nil if none exists. The medication scheduler uses this
// as a fallback for the overlap-guard data once a plan transitions out of
// APPROVED — the previous tick that consumed the final step also flipped the
// status, so the next tick can no longer see the plan via
// GetLatestActiveOrPendingTZTransitionPlan and would otherwise lose the
// consumed-step times that suppress the just-superseded normal-schedule slots.
func (r *Repo) GetLatestCompletedTZTransitionPlan() (*TZTransitionPlan, error) {
	row := r.db.QueryRow(
		`SELECT ` + planSelectCols + `
		 FROM tz_transition_plans
		 WHERE status = 'COMPLETED'
		 ORDER BY created_at_unix DESC, id DESC LIMIT 1`,
	)
	p, err := scanPlan(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

// GetTZTransitionPlan returns the plan with the supplied id, or nil if none
// exists. Used by tests (and any caller that already knows the plan id) to
// inspect the plan's current state regardless of its status. The repo's
// other getters are status-filtered, so this is the simplest way to verify
// the lifecycle without depending on the plan being the latest of its kind.
func (r *Repo) GetTZTransitionPlan(id int64) (*TZTransitionPlan, error) {
	row := r.db.QueryRow(
		`SELECT `+planSelectCols+`
		 FROM tz_transition_plans WHERE id = ?`,
		id,
	)
	p, err := scanPlan(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

// GetLatestActiveOrPendingTZTransitionPlan returns the most recent plan in
// PENDING_APPROVAL, NOTIFIED, or APPROVED status, or nil if none exists.
func (r *Repo) GetLatestActiveOrPendingTZTransitionPlan() (*TZTransitionPlan, error) {
	row := r.db.QueryRow(
		`SELECT ` + planSelectCols + `
		 FROM tz_transition_plans
		 WHERE status IN ('PENDING_APPROVAL','NOTIFIED','APPROVED')
		 ORDER BY created_at_unix DESC, id DESC LIMIT 1`,
	)
	p, err := scanPlan(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

// UpdateTZTransitionPlanStatus atomically transitions a plan's status.
// If expectedStatus is non-empty, the update only applies when the current status matches.
func (r *Repo) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	var err error
	if expectedStatus != "" {
		var res sql.Result
		res, err = r.db.Exec(
			`UPDATE tz_transition_plans SET status = ?, user_action = ? WHERE id = ? AND status = ?`,
			newStatus, userAction, id, expectedStatus,
		)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return nil // no-op: status already changed, idempotent
		}
		return nil
	}
	_, err = r.db.Exec(
		`UPDATE tz_transition_plans SET status = ?, user_action = ? WHERE id = ?`,
		newStatus, userAction, id,
	)
	return err
}

// SetTZTransitionPlanApproved marks a plan as APPROVED and records the approval time.
// The update is guarded to only apply when the plan is in PENDING_APPROVAL or NOTIFIED
// status, preventing stale Telegram callbacks from resurrecting superseded or cancelled plans.
//
// Most callers should go through tzreschedule.LifecycleService.Approve, which
// wraps this update + the pre-materialize step insert in a single transaction
// so a crash between them cannot leave the plan APPROVED with no intake rows
// to fire. This bare receiver is kept for legacy paths that don't yet route
// through the lifecycle service.
func (r *Repo) SetTZTransitionPlanApproved(id int64, approvedAt time.Time) (bool, error) {
	return SetTZTransitionPlanApprovedTx(r.db, id, approvedAt)
}

// SetTZTransitionPlanApprovedTx is the tx-aware variant: the same UPDATE
// against any storedb.TX (free *sql.DB or an active *sql.Tx). Used by
// store.Repos.ApproveAndMaterialize to share one transaction with the
// medication.MaterializePlanStepsAsIntakesTx call so the two writes are
// atomic. See tzreschedule.LifecycleService for the runtime entry point.
func SetTZTransitionPlanApprovedTx(tx storedb.TX, id int64, approvedAt time.Time) (bool, error) {
	res, err := tx.Exec(
		`UPDATE tz_transition_plans SET status = 'APPROVED', approved_at_unix = ?, user_action = 'approved'
		 WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		storedb.TimeToUnix(approvedAt), id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SetTZTransitionPlanRejected marks a plan as REJECTED.
// The update is guarded to only apply when the plan is in PENDING_APPROVAL or NOTIFIED
// status, preventing stale Telegram callbacks from affecting cancelled or superseded plans.
func (r *Repo) SetTZTransitionPlanRejected(id int64) (bool, error) {
	res, err := r.db.Exec(
		`UPDATE tz_transition_plans SET status = 'REJECTED', user_action = 'rejected'
		 WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RejectTZTransitionPlanAndRevertTimezone atomically marks a plan as REJECTED and
// reverts the stored timezone back to the plan's OldTZ. This ensures that after
// rejection the scheduler continues to use the original timezone rather than the
// newly-stored one. Returns true if the plan was found and updated.
func (r *Repo) RejectTZTransitionPlanAndRevertTimezone(id int64) (bool, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck

	var oldTZ string
	err = tx.QueryRow(
		`SELECT old_tz FROM tz_transition_plans WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		id,
	).Scan(&oldTZ)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	res, err := tx.Exec(
		`UPDATE tz_transition_plans SET status = 'REJECTED', user_action = 'rejected'
		 WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}

	// Revert timezone_history to oldTZ so the scheduler resumes on the original schedule.
	_, err = tx.Exec(`
		INSERT INTO timezone_history (timezone)
		SELECT ?
		WHERE COALESCE(
			(SELECT timezone FROM timezone_history ORDER BY recorded_at DESC, id DESC LIMIT 1),
			'') != ?`, oldTZ, oldTZ)
	if err != nil {
		return false, err
	}

	return true, tx.Commit()
}

// MarkPlanNotified atomically transitions a plan from PENDING_APPROVAL to NOTIFIED.
// Returns true if the transition occurred (this process "won" the CAS), false if the
// plan was already in a different state (duplicate protection for concurrent schedulers).
func (r *Repo) MarkPlanNotified(id int64) (bool, error) {
	res, err := r.db.Exec(
		`UPDATE tz_transition_plans SET status = 'NOTIFIED', notified_at_unix = CAST(strftime('%s','now') AS INTEGER)
		 WHERE id = ? AND status = 'PENDING_APPROVAL'`,
		id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ResetPlanToPending reverts a NOTIFIED plan back to PENDING_APPROVAL.
// Used when the notification send fails so the plan can be retried on the next scheduler tick.
func (r *Repo) ResetPlanToPending(id int64) error {
	_, err := r.db.Exec(
		`UPDATE tz_transition_plans SET status = 'PENDING_APPROVAL', notified_at_unix = NULL
		 WHERE id = ? AND status = 'NOTIFIED'`,
		id,
	)
	return err
}

// CreateTZTransitionPlanWithSteps atomically cancels any active plans and
// saves a new timezone transition plan in a single transaction. This prevents
// concurrent timezone updates from leaving multiple active plans.
//
// As part of the cancel-all step we also delete every PENDING source='tz_step'
// row in intake_log whose tz_plan_id is no longer attached to an APPROVED
// plan. This is the same janitor pattern as the planner's
// DeletePendingPreMaterializedIntakesForPlan call, executed inside this tx so
// a freshly-cancelled APPROVED plan cannot leak unfired step rows once the
// new plan has been created.
//
// The plan's steps live entirely inside plan.StepsJSON: the planner serializes
// the generated []tzreschedule.TransitionStep into that column at call time,
// and medication.MaterializePlanStepsAsIntakesTx reads from it again at
// approve time to insert the PENDING source='tz_step' intake_log rows. Track D
// Task 13 dropped the separate tz_transition_steps table, so this method no
// longer touches a second table.
func (r *Repo) CreateTZTransitionPlanWithSteps(plan *TZTransitionPlan) (int64, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() {
		if err != nil {
			tx.Rollback() //nolint:errcheck
		}
	}()

	// Cancel all active plans within this transaction to prevent races where
	// concurrent timezone updates both create active plans.
	_, err = tx.Exec(
		`UPDATE tz_transition_plans SET status = 'CANCELLED', user_action = 'superseded'
		 WHERE status IN ('PENDING_APPROVAL', 'NOTIFIED', 'APPROVED')`,
	)
	if err != nil {
		return 0, err
	}

	// Delete unfired pre-materialized step rows for any plan that is no
	// longer APPROVED. After the UPDATE above no APPROVED plan exists, so
	// every PENDING source='tz_step' row is now orphaned and must go.
	_, err = tx.Exec(
		`DELETE FROM intake_log
		 WHERE status = 'PENDING' AND source = 'tz_step'
		   AND tz_plan_id IS NOT NULL`,
	)
	if err != nil {
		return 0, err
	}

	res, err := tx.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		plan.OldTZ, plan.NewTZ, plan.Status, plan.StepsJSON, plan.InputsJSON, plan.PlanHash,
	)
	if err != nil {
		return 0, err
	}
	planID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	return planID, tx.Commit()
}

// GetPlanByHash looks up a plan by its inputs hash to enable deduplication.
func (r *Repo) GetPlanByHash(hash string) (*TZTransitionPlan, error) {
	row := r.db.QueryRow(
		`SELECT `+planSelectCols+`
		 FROM tz_transition_plans WHERE plan_hash = ?
		 ORDER BY created_at_unix DESC, id DESC LIMIT 1`,
		hash,
	)
	p, err := scanPlan(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}
