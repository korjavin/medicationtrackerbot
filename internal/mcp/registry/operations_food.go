package registry

import "encoding/json"

// FoodOperations returns the set of food-related operations for the registry.
// Includes read-only operations for browsing logs/products/targets and write
// operations whose backend handlers carry strong domain validation
// (FoodService.CreateFoodLog, SetFoodTargets).
func FoodOperations() []*Operation {
	return []*Operation{
		{
			ID:     "food.log.list",
			Topic:  "food",
			Method: "GET",
			Path:   "/api/food/log",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "date":      {"type": "string", "description": "YYYY-MM-DD; defaults to today in user's timezone"},
    "days":      {"type": "integer", "minimum": 1, "description": "Number of days to include (default 1; capped by MCP_MAX_QUERY_DAYS)"},
    "tz":        {"type": "string", "description": "IANA timezone name (e.g. America/Los_Angeles)"},
    "tz_offset": {"type": "integer", "description": "Fallback offset minutes west of UTC"}
  }
}`),
			Description:     "List food log entries grouped into meals. Use date+days or tz to control the window.",
			ResponseSummary: "JSON array of food groups; each group has logs[] with id, eaten_at, weight, carbs, protein, fat, calories, name, product_id.",
			Example: `result = api.call("food.log.list", params={"date": "2026-04-29", "days": 1})
output(result)`,
		},
		{
			ID:     "food.stats.read",
			Topic:  "food",
			Method: "GET",
			Path:   "/api/food/stats",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "date":      {"type": "string", "description": "YYYY-MM-DD anchor date; defaults to today"},
    "days":      {"type": "integer", "minimum": 1, "description": "Window length in days (default 7; capped by MCP_MAX_QUERY_DAYS)"},
    "tz":        {"type": "string"},
    "tz_offset": {"type": "integer"}
  }
}`),
			Description:     "Aggregated food stats over a date window: totals, daily averages, and breakdowns.",
			ResponseSummary: "Stats object with calories, carbs, protein, fat totals plus per-day arrays.",
			Example: `result = api.call("food.stats.read", params={"days": 7})
output(result)`,
		},
		{
			ID:              "food.targets.read",
			Topic:           "food",
			Method:          "GET",
			Path:            "/api/food/settings/targets",
			Risk:            RiskRead,
			Description:     "Get the user's daily nutrition targets (calories, carbs, protein, fat).",
			ResponseSummary: "Object with calories, carbs, protein, fat (all integers in their respective units).",
			Example: `result = api.call("food.targets.read")
output(result)`,
		},
		{
			ID:     "food.products.list",
			Topic:  "food",
			Method: "GET",
			Path:   "/api/food/products",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "limit": {"type": "integer", "description": "Max products to return (default 50)"}
  }
}`),
			Description:     "List the user's saved food products (used as templates when logging).",
			ResponseSummary: "JSON object with 'products' (array of {id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, is_meal}) and 'total' (int).",
			Example: `result = api.call("food.products.list")
output({"count": result["total"], "products": result["products"]})`,
		},
		{
			ID:     "food.products.search",
			Topic:  "food",
			Method: "GET",
			Path:   "/api/food/products/search",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "q":     {"type": "string", "description": "Search query (matches name)"},
    "limit": {"type": "integer", "description": "Max results (default 20)"}
  }
}`),
			Description:     "Search the user's saved food products by name. Use this to find product_id before logging a meal.",
			ResponseSummary: "JSON array of matching products with id, name, barcode, per-100g macros.",
			Example: `result = api.call("food.products.search", params={"q": "oatmeal"})
output(result)`,
		},
		{
			ID:     "food.log.create",
			Topic:  "food",
			Method: "POST",
			Path:   "/api/food/log",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["eaten_at", "weight", "calories"],
  "properties": {
    "eaten_at":   {"type": "string", "description": "ISO8601 timestamp (RFC3339 preferred)"},
    "weight":     {"type": "integer", "description": "Grams consumed (>= 0)"},
    "carbs":      {"type": "integer", "description": "Total carbs in grams"},
    "protein":    {"type": "integer", "description": "Total protein in grams"},
    "fat":        {"type": "integer", "description": "Total fat in grams"},
    "calories":   {"type": "integer", "description": "Total kcal"},
    "name":       {"type": "string"},
    "product_id": {"type": ["integer", "null"], "description": "Optional saved product reference"},
    "barcode":    {"type": "string"},
    "per_100g":   {"type": "boolean", "description": "If true, treat the carb/protein/fat/calories as per-100g and let the server scale by weight"}
  }
}`),
			Description:     "Log a food intake entry. Goes through FoodService validation; macros must be non-negative. When per_100g is true, the server scales values by the consumed weight.",
			ResponseSummary: "FoodLog object with id, eaten_at, weight, totals, name, product_id.",
			Example: `result = api.call(
    "food.log.create",
    body={
        "eaten_at": "2026-04-29T12:30:00Z",
        "weight": 200,
        "carbs": 40,
        "protein": 8,
        "fat": 5,
        "calories": 250,
        "name": "Oatmeal with banana",
    },
)
output(result)`,
		},
		{
			ID:     "food.targets.set",
			Topic:  "food",
			Method: "POST",
			Path:   "/api/food/settings/targets",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["calories", "carbs", "protein", "fat"],
  "properties": {
    "calories": {"type": "integer", "description": "Daily kcal target (>= 0)"},
    "carbs":    {"type": "integer", "description": "Daily carbs target in grams (>= 0)"},
    "protein":  {"type": "integer", "description": "Daily protein target in grams (>= 0)"},
    "fat":      {"type": "integer", "description": "Daily fat target in grams (>= 0)"}
  }
}`),
			Description:     "Replace the user's daily nutrition targets. All values must be non-negative.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "food.targets.set",
    body={"calories": 2200, "carbs": 250, "protein": 140, "fat": 70},
)
output({"updated": True})`,
		},
	}
}
