package registry

import "encoding/json"

// FoodOperations returns the set of food-related operations for the registry.
// Includes read-only operations for browsing logs/products/targets and write
// operations whose backend handlers carry strong domain validation
// (FoodService.CreateLog, SetTargets).
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
			Description:     "List food log entries for a date window, grouped into meals. date defaults to today in the user's timezone. tz overrides with an IANA name (e.g. 'America/Los_Angeles'); tz_offset (minutes west of UTC) is a fallback only when the IANA name is unrecognized. The date string is interpreted in whichever timezone resolves first: tz, then tz_offset, then the user's stored timezone.",
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
			Description:     "Search the user's saved food products (and the open_food_facts cache) by name. ALWAYS call this before food.log.create unless you already have a product_id. Logging the same food without a product_id creates a NEW duplicate product row each time, breaking history rollup and statistics. Search with the canonical English term (e.g. \"boiled egg\", not \"вареное яйцо\" or \"boiled eggs breakfast\") so you find existing rows even when the user described the meal in another language or with situational notes.",
			ResponseSummary: "JSON array of matching products with id, name, barcode, per-100g macros.",
			Example: `result = api.call("food.products.search", params={"q": "oatmeal"})
output(result)`,
		},
		{
			ID:     "food.products.frequent",
			Topic:  "food",
			Method: "GET",
			Path:   "/api/food/products",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "limit": {"type": "integer", "description": "Max products to return (default 10)"}
  }
}`),
			Description:     "Top-N most frequently logged products for this user (highest usage_count first). Use this to discover canonical names the user has logged before, so reused meals share the same food_product entry.",
			ResponseSummary: "JSON object with 'products' (array of {id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal}) and 'total' (int).",
			Example: `result = api.call("food.products.frequent", params={"limit": 10})
for p in result["products"]:
    output({"id": p["id"], "name": p["name"]})`,
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
    "name":       {"type": "string", "description": "Canonical English food name in generic form, intended to be reused across many log entries. Prefer a name already present in the user's catalog (food.products.search / food.products.frequent) or the open_food_facts cache. Use the singular, lowercase, ingredient-style form with no situational notes — good: \"boiled egg\", \"oatmeal\", \"chicken breast\". Bad: \"вареное яйцо\" (not English), \"boiled eggs breakfast\" (meal-time note), \"boiled eggs airline\" (context note), \"2 boiled eggs\" (quantity belongs in weight)."},
    "product_id": {"type": ["integer", "null"], "description": "Optional saved product reference"},
    "barcode":    {"type": "string"},
    "per_100g":   {"type": "boolean", "description": "If true, treat the carb/protein/fat/calories as per-100g and let the server scale by weight"}
  }
}`),
			Description:     "Log a food intake entry. Before logging, prefer to search the user's catalog with food.products.search or food.products.frequent and pass the matching product_id so this entry rolls up under the same product. If you only pass name (no product_id), the server upserts a food_products row by name — so the name you choose becomes the shared identity for every future log of this food. Always normalize names to canonical English (e.g. \"boiled egg\", not \"вареное яйцо\"), in their generic form without meal-time, quantity, or context annotations (e.g. \"boiled egg\", not \"boiled eggs breakfast\" or \"boiled eggs airline\"). When in doubt, search first and reuse the existing product_id rather than creating a near-duplicate. Goes through FoodService validation; macros must be non-negative. When per_100g is true, the server scales values by the consumed weight.",
			ResponseSummary: "{status, id, product_id, name} — product_id is the food_products row that was matched or upserted from name; null only if no name was provided.",
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
			ID:     "food.log.from_description",
			Topic:  "food",
			Method: "POST",
			Path:   "/api/food/log/from-description",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["description"],
  "properties": {
    "description": {"type": "string", "description": "Free-text meal description (e.g. \"200g grilled chicken with a cup of rice\"). The server's AI parser splits this into individual food items, estimates weights and macros, and logs each as a separate FoodLog entry."},
    "eaten_at":    {"type": "string", "description": "ISO8601 timestamp (RFC3339 preferred); defaults to now if omitted. All parsed items share this timestamp."}
  }
}`),
			Description:     "Log one or more food intake entries from a natural-language meal description. Uses the same AI parser as the bot's /food command — pass the user's words verbatim. Unlike food.log.create, this endpoint does NOT upsert into food_products; AI-parsed items are stored as standalone FoodLog rows without joining the user's product catalog. Prefer food.log.create with a product_id when the user is logging a single known food and you want the entry to roll up under an existing product. Returns the created logs so they can be displayed or undone.",
			ResponseSummary: "{status, items:[{id, name, weight, carbs, protein, fat, calories}], failed}.",
			Example: `result = api.call(
    "food.log.from_description",
    body={"description": "200g grilled chicken with a cup of rice"},
)
output({"items": result["items"]})`,
		},
		{
			ID:         "food.log.update",
			Topic:      "food",
			Method:     "PUT",
			Path:       "/api/food/log/{id}",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["eaten_at", "weight", "calories"],
  "properties": {
    "eaten_at":   {"type": "string", "description": "ISO8601 timestamp (RFC3339 preferred)"},
    "weight":     {"type": "integer", "description": "Grams consumed (>= 0)"},
    "carbs":      {"type": "integer"},
    "protein":    {"type": "integer"},
    "fat":        {"type": "integer"},
    "calories":   {"type": "integer"},
    "name":       {"type": "string", "description": "Canonical English, generic form (see food.log.create). Don't append meal-time, quantity, or context notes — those belong in eaten_at / weight or nowhere at all."},
    "product_id": {"type": ["integer", "null"]},
    "barcode":    {"type": "string"},
    "per_100g":   {"type": "boolean", "description": "If true, server scales the macros by weight"}
  }
}`),
			Description:     "Update an existing food log entry. The body shape mirrors food.log.create; this is a full replacement, so always read the existing log via food.log.list and send the merged object back. Same naming rules as food.log.create apply — keep the name canonical English and generic so logs across days share a single product_id.",
			ResponseSummary: "Updated FoodLog object.",
			Example: `api.call(
    "food.log.update",
    path_params={"id": 42},
    body={
        "eaten_at": "2026-04-29T12:30:00Z",
        "weight": 250,
        "calories": 280,
        "carbs": 42, "protein": 9, "fat": 6,
        "name": "Oatmeal with banana",
    },
)
output({"updated": 42})`,
		},
		{
			ID:              "food.log.delete",
			Topic:           "food",
			Method:          "DELETE",
			Path:            "/api/food/log/{id}",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Delete a food log entry by id.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("food.log.delete", path_params={"id": 42})
output({"deleted": 42})`,
		},
		{
			ID:         "food.products.update",
			Topic:      "food",
			Method:     "PUT",
			Path:       "/api/food/products/{id}",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name":             {"type": "string", "description": "Canonical English, generic form (see food.log.create) — the product name will be reused across every future log."},
    "barcode":          {"type": "string"},
    "carbs_100g":       {"type": "number"},
    "protein_100g":     {"type": "number"},
    "fat_100g":         {"type": "number"},
    "energy_kcal_100g": {"type": "number"},
    "is_meal":          {"type": "boolean"},
    "total_weight_g":   {"type": "integer", "description": "Reference weight for is_meal=true entries"}
  }
}`),
			Description:     "Update a saved food product. Full-replacement semantics: omitted fields decode to zero values. Read the product via food.products.list/search before sending.",
			ResponseSummary: "Updated FoodProduct object.",
			Example: `api.call(
    "food.products.update",
    path_params={"id": 7},
    body={"name": "Oatmeal", "carbs_100g": 60, "protein_100g": 12, "fat_100g": 7, "energy_kcal_100g": 360},
)
output({"updated": 7})`,
		},
		{
			ID:              "food.products.delete",
			Topic:           "food",
			Method:          "DELETE",
			Path:            "/api/food/products/{id}",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Delete a saved food product by id.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("food.products.delete", path_params={"id": 7})
output({"deleted": 7})`,
		},
		{
			ID:     "food.products.from_logs",
			Topic:  "food",
			Method: "POST",
			Path:   "/api/food/products/from-logs",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "log_ids"],
  "properties": {
    "name":    {"type": "string", "description": "Display name for the new meal product"},
    "log_ids": {"type": "array", "items": {"type": "integer"}, "minItems": 1, "description": "Food log entries to aggregate into the meal"}
  }
}`),
			Description:     "Promote a set of food log entries into a saved meal product (so the user can re-log the meal later by reference).",
			ResponseSummary: "Created FoodProduct object with is_meal=true.",
			Example: `result = api.call(
    "food.products.from_logs",
    body={"name": "Sunday Brunch", "log_ids": [101, 102, 103]},
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
