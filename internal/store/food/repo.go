// Package food owns the food_log, food_products, and food_target_* columns on
// the singleton settings row.
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.Food; new code should depend on *food.Repo (or a narrow
// interface satisfied by it) directly.
package food

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// FoodLog is one row of the food_log table — a single eating event with
// optional product reference (for repeated foods / meals).
type FoodLog struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	EatenAt   time.Time `json:"eaten_at"`
	Weight    int       `json:"weight"`
	Carbs     int       `json:"carbs"`    // total grams
	Protein   int       `json:"protein"`  // total grams
	Fat       int       `json:"fat"`      // total grams
	Calories  int       `json:"calories"` // total kcal
	Name      string    `json:"name,omitempty"`
	ProductID *int64    `json:"product_id,omitempty"`
	IsMeal    bool      `json:"is_meal"`
}

// FoodProduct is a saved per-user food / meal definition (per-100g
// macronutrients + usage stats). Meals (IsMeal=true) carry the original
// total weight used for portion arithmetic.
type FoodProduct struct {
	ID             int64     `json:"id"`
	UserID         int64     `json:"user_id"`
	Name           string    `json:"name"`
	Barcode        *string   `json:"barcode,omitempty"`
	Carbs100g      float64   `json:"carbs_100g"`
	Protein100g    float64   `json:"protein_100g"`
	Fat100g        float64   `json:"fat_100g"`
	EnergyKcal100g float64   `json:"energy_kcal_100g"`
	UsageCount     int       `json:"usage_count"`
	IsMeal         bool      `json:"is_meal"`
	TotalWeightG   int       `json:"total_weight_g"`
	CreatedAt      time.Time `json:"created_at"`
	LastUsedAt     time.Time `json:"last_used_at"`
}

// OpenFoodFact is one row of the open_food_facts global lookup table.
type OpenFoodFact struct {
	Barcode        string  `json:"barcode"`
	Name           string  `json:"name"`
	Carbs100g      float64 `json:"carbs_100g"`
	Protein100g    float64 `json:"protein_100g"`
	Fat100g        float64 `json:"fat_100g"`
	EnergyKcal100g float64 `json:"energy_kcal_100g"`
}

// FoodTargets are the per-user daily macro / calorie targets, stored as four
// columns on the singleton settings row.
type FoodTargets struct {
	Calories int `json:"calories"`
	Carbs    int `json:"carbs"`
	Protein  int `json:"protein"`
	Fat      int `json:"fat"`
}

// FoodStats is an aggregation of one or more days' food_log rows.
type FoodStats struct {
	Calories int `json:"calories"`
	Carbs    int `json:"carbs"`
	Protein  int `json:"protein"`
	Fat      int `json:"fat"`
}

// FoodProductsFilter is the query filter for ListProducts.
type FoodProductsFilter struct {
	IsMeal *bool
	Query  string
	Offset int
	Limit  int
	Sort   string // "usage", "last_used", "name"
}

// Repo is the food repository. Construct with New; share one *Repo per
// process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db *storedb.DB
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d}
}

// UpsertProduct inserts a product or, on (user_id, name) conflict,
// increments usage_count and refreshes last_used_at while preserving
// previously-set macro fields when the new row supplies zeros.
func (r *Repo) UpsertProduct(ctx context.Context, p *FoodProduct) error {
	query := `
		INSERT INTO food_products (user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, last_used_at, is_meal, total_weight_g)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
		ON CONFLICT(user_id, name) DO UPDATE SET
			barcode = COALESCE(excluded.barcode, food_products.barcode),
			carbs_100g = COALESCE(NULLIF(excluded.carbs_100g, 0), food_products.carbs_100g),
			protein_100g = COALESCE(NULLIF(excluded.protein_100g, 0), food_products.protein_100g),
			fat_100g = COALESCE(NULLIF(excluded.fat_100g, 0), food_products.fat_100g),
			energy_kcal_100g = COALESCE(NULLIF(excluded.energy_kcal_100g, 0), food_products.energy_kcal_100g),
			usage_count = food_products.usage_count + 1,
			is_meal = CASE WHEN excluded.is_meal THEN 1 ELSE food_products.is_meal END,
			total_weight_g = CASE WHEN excluded.is_meal THEN excluded.total_weight_g ELSE food_products.total_weight_g END,
			last_used_at = CURRENT_TIMESTAMP
	`
	var barcode interface{}
	if p.Barcode != nil && *p.Barcode != "" {
		barcode = *p.Barcode
	}
	_, err := r.db.ExecContext(ctx, query, p.UserID, p.Name, barcode, p.Carbs100g, p.Protein100g, p.Fat100g, p.EnergyKcal100g, p.IsMeal, p.TotalWeightG)
	return err
}

// GetProductByName returns the user's product with the given name, or
// sql.ErrNoRows.
func (r *Repo) GetProductByName(ctx context.Context, userID int64, name string) (*FoodProduct, error) {
	query := `
		SELECT id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at
		FROM food_products
		WHERE user_id = ? AND name = ?
	`
	var p FoodProduct
	var barcode sql.NullString
	err := r.db.QueryRowContext(ctx, query, userID, name).Scan(&p.ID, &p.UserID, &p.Name, &barcode, &p.Carbs100g, &p.Protein100g, &p.Fat100g, &p.EnergyKcal100g, &p.UsageCount, &p.IsMeal, &p.TotalWeightG, &p.CreatedAt, &p.LastUsedAt)
	if err != nil {
		return nil, err
	}
	if barcode.Valid {
		b := barcode.String
		p.Barcode = &b
	}
	return &p, nil
}

// GetProductByID returns the user's product with the given id, or
// sql.ErrNoRows.
func (r *Repo) GetProductByID(ctx context.Context, userID, id int64) (*FoodProduct, error) {
	query := `
		SELECT id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at
		FROM food_products
		WHERE user_id = ? AND id = ?
	`
	var p FoodProduct
	var barcode sql.NullString
	err := r.db.QueryRowContext(ctx, query, userID, id).Scan(&p.ID, &p.UserID, &p.Name, &barcode, &p.Carbs100g, &p.Protein100g, &p.Fat100g, &p.EnergyKcal100g, &p.UsageCount, &p.IsMeal, &p.TotalWeightG, &p.CreatedAt, &p.LastUsedAt)
	if err != nil {
		return nil, err
	}
	if barcode.Valid {
		b := barcode.String
		p.Barcode = &b
	}
	return &p, nil
}

// UpdateProduct updates a product owned by the given user. Returns
// sql.ErrNoRows when no row matches the id+user_id pair.
func (r *Repo) UpdateProduct(ctx context.Context, p *FoodProduct) error {
	var barcode interface{}
	if p.Barcode != nil && *p.Barcode != "" {
		barcode = *p.Barcode
	}
	res, err := r.db.ExecContext(ctx,
		"UPDATE food_products SET name = ?, barcode = ?, carbs_100g = ?, protein_100g = ?, fat_100g = ?, energy_kcal_100g = ?, is_meal = ?, total_weight_g = ? WHERE id = ? AND user_id = ?",
		p.Name, barcode, p.Carbs100g, p.Protein100g, p.Fat100g, p.EnergyKcal100g, p.IsMeal, p.TotalWeightG, p.ID, p.UserID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeleteProduct removes a product owned by the given user. Returns
// sql.ErrNoRows when no row matches.
func (r *Repo) DeleteProduct(ctx context.Context, id, userID int64) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM food_products WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ListProducts returns a filtered, paginated list of the user's products
// plus the unfiltered total count for pagination.
func (r *Repo) ListProducts(ctx context.Context, userID int64, filter FoodProductsFilter) ([]FoodProduct, int, error) {
	var countQuery strings.Builder
	var selectQuery strings.Builder
	var args []interface{}

	countQuery.WriteString("SELECT COUNT(*) FROM food_products WHERE user_id = ?")
	selectQuery.WriteString("SELECT id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at FROM food_products WHERE user_id = ?")
	args = append(args, userID)

	if filter.IsMeal != nil {
		countQuery.WriteString(" AND is_meal = ?")
		selectQuery.WriteString(" AND is_meal = ?")
		args = append(args, *filter.IsMeal)
	}

	if filter.Query != "" {
		countQuery.WriteString(" AND name LIKE ?")
		selectQuery.WriteString(" AND name LIKE ?")
		args = append(args, "%"+filter.Query+"%")
	}

	var total int
	err := r.db.QueryRowContext(ctx, countQuery.String(), args...).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	switch filter.Sort {
	case "last_used":
		selectQuery.WriteString(" ORDER BY last_used_at DESC")
	case "name":
		selectQuery.WriteString(" ORDER BY name ASC")
	default: // "usage" or empty
		selectQuery.WriteString(" ORDER BY usage_count DESC, last_used_at DESC")
	}

	selectQuery.WriteString(" LIMIT ? OFFSET ?")
	args = append(args, filter.Limit, filter.Offset)

	rows, err := r.db.QueryContext(ctx, selectQuery.String(), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var products []FoodProduct
	for rows.Next() {
		var p FoodProduct
		var barcode sql.NullString
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &barcode, &p.Carbs100g, &p.Protein100g, &p.Fat100g, &p.EnergyKcal100g, &p.UsageCount, &p.IsMeal, &p.TotalWeightG, &p.CreatedAt, &p.LastUsedAt); err != nil {
			return nil, 0, err
		}
		if barcode.Valid {
			b := barcode.String
			p.Barcode = &b
		}
		products = append(products, p)
	}
	return products, total, nil
}

// SearchProducts returns up to 50 products matching queryStr, drawing
// from both the user's saved products and the global open_food_facts table.
// Meals sort first, then by usage_count desc, then by name.
func (r *Repo) SearchProducts(ctx context.Context, userID int64, queryStr string) ([]FoodProduct, error) {
	likeQuery := "%" + queryStr + "%"

	query := `
		SELECT id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at
		FROM food_products
		WHERE user_id = ? AND (name LIKE ? OR barcode LIKE ?)

		UNION ALL

		SELECT 0 as id, 0 as user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, 0 as usage_count, 0 as is_meal, 0 as total_weight_g, CURRENT_TIMESTAMP as created_at, CURRENT_TIMESTAMP as last_used_at
		FROM open_food_facts
		WHERE name LIKE ? OR barcode LIKE ?

		ORDER BY is_meal DESC, usage_count DESC, name COLLATE NOCASE ASC
		LIMIT 50
	`
	rows, err := r.db.QueryContext(ctx, query, userID, likeQuery, likeQuery, likeQuery, likeQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var products []FoodProduct
	for rows.Next() {
		var p FoodProduct
		var barcode sql.NullString
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &barcode, &p.Carbs100g, &p.Protein100g, &p.Fat100g, &p.EnergyKcal100g, &p.UsageCount, &p.IsMeal, &p.TotalWeightG, &p.CreatedAt, &p.LastUsedAt); err != nil {
			return nil, err
		}
		if barcode.Valid {
			b := barcode.String
			p.Barcode = &b
		}
		products = append(products, p)
	}
	return products, nil
}

// CreateMealFromLogs aggregates the given food_log rows (all owned by
// userID) into a new is_meal=true FoodProduct with per-100g macros derived
// from totals. Returns sql.ErrNoRows-shaped errors when any id is missing
// or belongs to a different user.
func (r *Repo) CreateMealFromLogs(ctx context.Context, userID int64, name string, logIDs []int64) (*FoodProduct, error) {
	if len(logIDs) == 0 {
		return nil, fmt.Errorf("no log IDs provided")
	}

	// Dedup logIDs to know exactly how many unique IDs we expect
	uniqueIDs := make(map[int64]struct{})
	for _, id := range logIDs {
		uniqueIDs[id] = struct{}{}
	}

	// Prepare IN clause placeholders
	placeholders := make([]string, 0, len(uniqueIDs))
	args := make([]interface{}, 0, len(uniqueIDs)+1)
	args = append(args, userID)
	for id := range uniqueIDs {
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}

	query := fmt.Sprintf(`
		SELECT id, user_id, eaten_at, weight, carbs, protein, fat, calories, name, product_id
		FROM food_log
		WHERE user_id = ? AND id IN (%s)
	`, strings.Join(placeholders, ","))

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var totalWeight, totalCarbs, totalProtein, totalFat, totalCalories int
	var count int

	for rows.Next() {
		var l FoodLog
		var lname sql.NullString
		var productID sql.NullInt64
		if err := rows.Scan(&l.ID, &l.UserID, &l.EatenAt, &l.Weight, &l.Carbs, &l.Protein, &l.Fat, &l.Calories, &lname, &productID); err != nil {
			return nil, err
		}
		totalWeight += l.Weight
		totalCarbs += l.Carbs
		totalProtein += l.Protein
		totalFat += l.Fat
		totalCalories += l.Calories
		count++
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	if count == 0 {
		return nil, fmt.Errorf("no valid food logs found for the given IDs")
	}

	if count != len(uniqueIDs) {
		return nil, fmt.Errorf("could not find all requested food logs; some may be deleted or belong to another user")
	}

	if totalWeight <= 0 {
		return nil, fmt.Errorf("total weight must be greater than 0")
	}

	// Calculate per 100g values
	mult := 100.0 / float64(totalWeight)
	c100 := float64(totalCarbs) * mult
	p100 := float64(totalProtein) * mult
	f100 := float64(totalFat) * mult
	k100 := float64(totalCalories) * mult

	product := &FoodProduct{
		UserID:         userID,
		Name:           name,
		Carbs100g:      c100,
		Protein100g:    p100,
		Fat100g:        f100,
		EnergyKcal100g: k100,
		IsMeal:         true,
		TotalWeightG:   totalWeight,
	}

	if err := r.UpsertProduct(ctx, product); err != nil {
		return nil, err
	}

	// Get the generated ID
	var createdProduct FoodProduct
	err = r.db.QueryRowContext(ctx, "SELECT id, user_id, name, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at FROM food_products WHERE user_id = ? AND name = ?", userID, name).Scan(
		&createdProduct.ID, &createdProduct.UserID, &createdProduct.Name, &createdProduct.Carbs100g, &createdProduct.Protein100g, &createdProduct.Fat100g, &createdProduct.EnergyKcal100g, &createdProduct.UsageCount, &createdProduct.IsMeal, &createdProduct.TotalWeightG, &createdProduct.CreatedAt, &createdProduct.LastUsedAt)
	if err != nil {
		return nil, err
	}

	return &createdProduct, nil
}

// CreateLog inserts a single food_log row. eaten_at is normalised to UTC
// so SQLite's lexicographic datetime comparison aligns with the UTC midnight
// boundaries used elsewhere in this package.
func (r *Repo) CreateLog(ctx context.Context, f *FoodLog) (int64, error) {
	if f.ProductID != nil {
		var exists int
		err := r.db.QueryRowContext(ctx, "SELECT 1 FROM food_products WHERE id = ? AND user_id = ?", *f.ProductID, f.UserID).Scan(&exists)
		if err == sql.ErrNoRows {
			return 0, fmt.Errorf("invalid product_id: product does not exist or belongs to another user")
		} else if err != nil {
			return 0, err
		}
	}

	// Always store eaten_at in UTC so that SQLite's lexicographic datetime
	// comparison works correctly against the UTC midnight boundaries used in
	// ListLogs / GetStats.  Without this, a +01:00 offset stored by a
	// CET server would sort as if it were an hour later than it actually is.
	eatenAt := f.EatenAt.UTC()

	res, err := r.db.ExecContext(ctx,
		"INSERT INTO food_log (user_id, eaten_at, weight, carbs, protein, fat, calories, name, product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		f.UserID, eatenAt, f.Weight, f.Carbs, f.Protein, f.Fat, f.Calories, f.Name, f.ProductID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateLog updates a food_log row owned by the given user. Returns
// sql.ErrNoRows when no row matches.
func (r *Repo) UpdateLog(ctx context.Context, f *FoodLog) error {
	if f.ProductID != nil {
		var exists int
		err := r.db.QueryRowContext(ctx, "SELECT 1 FROM food_products WHERE id = ? AND user_id = ?", *f.ProductID, f.UserID).Scan(&exists)
		if err == sql.ErrNoRows {
			return fmt.Errorf("invalid product_id: product does not exist or belongs to another user")
		} else if err != nil {
			return err
		}
	}

	// Normalise to UTC for the same reason as CreateLog.
	eatenAt := f.EatenAt.UTC()

	res, err := r.db.ExecContext(ctx,
		"UPDATE food_log SET eaten_at = ?, weight = ?, carbs = ?, protein = ?, fat = ?, calories = ?, name = ?, product_id = ? WHERE id = ? AND user_id = ?",
		eatenAt, f.Weight, f.Carbs, f.Protein, f.Fat, f.Calories, f.Name, f.ProductID, f.ID, f.UserID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ListLogs returns the user's food_log rows for [date - (days-1), date]
// using calendar midnights in the location of `date` (DST-safe) ordered
// ascending by eaten_at.
func (r *Repo) ListLogs(ctx context.Context, userID int64, date time.Time, days int) ([]FoodLog, error) {
	// Range for the days — compute calendar midnights in the client's timezone so DST
	// transitions don't shift boundaries by an hour, then convert to UTC for SQLite.
	dayMidnight := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, date.Location())
	endOfDay := dayMidnight.AddDate(0, 0, 1).UTC()
	startOfDay := dayMidnight.AddDate(0, 0, -(days - 1)).UTC()

	query := `
		SELECT
			fl.id, fl.user_id, fl.eaten_at, fl.weight, fl.carbs, fl.protein, fl.fat, fl.calories, fl.name, fl.product_id, fp.is_meal
		FROM food_log fl
		LEFT JOIN food_products fp ON fl.product_id = fp.id AND fp.user_id = fl.user_id
		WHERE fl.user_id = ? AND fl.eaten_at >= ? AND fl.eaten_at < ?
		ORDER BY fl.eaten_at ASC
	`

	rows, err := r.db.QueryContext(ctx, query, userID, startOfDay, endOfDay)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []FoodLog
	for rows.Next() {
		var l FoodLog
		var name sql.NullString
		var productID sql.NullInt64
		var isMeal sql.NullBool

		if err := rows.Scan(&l.ID, &l.UserID, &l.EatenAt, &l.Weight, &l.Carbs, &l.Protein, &l.Fat, &l.Calories, &name, &productID, &isMeal); err != nil {
			return nil, err
		}
		if name.Valid {
			l.Name = name.String
		}
		if productID.Valid {
			id := productID.Int64
			l.ProductID = &id
		}
		if isMeal.Valid {
			l.IsMeal = isMeal.Bool
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// DeleteLog removes a food_log row owned by the given user. Returns
// sql.ErrNoRows when no row matches.
func (r *Repo) DeleteLog(ctx context.Context, id, userID int64) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM food_log WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetStats sums calories/carbs/protein/fat across the user's food_log
// rows for [endDate - (days-1), endDate] (calendar midnights in endDate's
// location, DST-safe).
func (r *Repo) GetStats(ctx context.Context, userID int64, endDate time.Time, days int) (*FoodStats, error) {
	// Range for the days — calendar midnights in client timezone (DST-safe), same as ListLogs.
	dayMidnight := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, endDate.Location())
	endOfDay := dayMidnight.AddDate(0, 0, 1).UTC()
	startOfDay := dayMidnight.AddDate(0, 0, -(days - 1)).UTC()

	query := "SELECT COALESCE(SUM(calories), 0), COALESCE(SUM(carbs), 0), COALESCE(SUM(protein), 0), COALESCE(SUM(fat), 0) FROM food_log WHERE user_id = ? AND eaten_at >= ? AND eaten_at < ?"

	var stats FoodStats
	err := r.db.QueryRowContext(ctx, query, userID, startOfDay, endOfDay).Scan(&stats.Calories, &stats.Carbs, &stats.Protein, &stats.Fat)
	if err != nil {
		return nil, err
	}
	return &stats, nil
}

// GetTargets reads the per-user daily targets from the singleton
// settings row.
func (r *Repo) GetTargets(ctx context.Context) (FoodTargets, error) {
	var targets FoodTargets
	err := r.db.QueryRowContext(ctx,
		"SELECT food_target_calories, food_target_carbs, food_target_protein, food_target_fat FROM settings WHERE id = 1",
	).Scan(&targets.Calories, &targets.Carbs, &targets.Protein, &targets.Fat)
	return targets, err
}

// SetTargets writes the per-user daily targets to the singleton settings
// row.
func (r *Repo) SetTargets(ctx context.Context, targets FoodTargets) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE settings SET food_target_calories = ?, food_target_carbs = ?, food_target_protein = ?, food_target_fat = ? WHERE id = 1",
		targets.Calories, targets.Carbs, targets.Protein, targets.Fat,
	)
	return err
}
