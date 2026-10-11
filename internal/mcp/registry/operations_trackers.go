package registry

import "encoding/json"

// TrackerOperations returns the user-tracker ops (epic med-1vy5): user-defined
// count / check-off trackers with a day/week/month target or limit. Served in
// cloud mode by web/domain/trackers.js through apishim.js's /api/trackers routes.
func TrackerOperations() []*Operation {
	return []*Operation{
		{
			ID:              "trackers.list",
			Topic:           "trackers",
			Method:          "GET",
			Path:            "/api/trackers",
			Risk:            RiskRead,
			Description:     "List the user's active trackers (e.g. water 8/day, coffee at most 3/day, stretching 3/week) with current-period progress. Use it to find a tracker's id/name before trackers.log or trackers.history.",
			ResponseSummary: "JSON array of trackers, oldest first: id, name, emoji, kind (count|check), unit (null when unset), step (default tap amount for count), target{op: atLeast|atMost, value, period: day|week|month}, reminder ({time} or null), archived, createdAt, progress{total, target, met} for the current day/ISO week/month in the account time zone. atMost with no logs is met.",
			ResponseExample: `[
  {"id": "tracker-1783339200000_k3j9x2ab", "name": "Water", "emoji": "💧", "kind": "count", "unit": "glass", "step": 1, "target": {"op": "atLeast", "value": 8, "period": "day"}, "reminder": null, "archived": false, "createdAt": "2026-07-06T12:00:00.000Z", "progress": {"total": 3, "target": 8, "met": false}},
  {"id": "tracker-1783339300000_p0q8w1cd", "name": "Stretching", "emoji": "🧘", "kind": "check", "unit": null, "step": 1, "target": {"op": "atLeast", "value": 3, "period": "week"}, "reminder": {"time": "20:00"}, "archived": false, "createdAt": "2026-07-06T12:01:40.000Z", "progress": {"total": 1, "target": 3, "met": false}}
]`,
			Example: `result = api.call("trackers.list")
output(result)`,
		},
		{
			ID:         "trackers.log",
			Topic:      "trackers",
			Method:     "POST",
			Path:       "/api/trackers/{tracker}/log",
			PathParams: []string{"tracker"},
			Risk:       RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "amount": {"type": "number", "description": "Count trackers only: how much to add, in the tracker's unit (default: the tracker's step). \"2 glasses of water\" = amount 2."},
    "at":     {"type": "string", "description": "Count trackers only: when it happened, RFC3339 timestamp (default now)."},
    "date":   {"type": "string", "description": "Check trackers only: the local day to mark done, YYYY-MM-DD (default today)."}
  }
}`),
			Description:     "Log progress on a tracker. Path param `tracker` is the tracker id OR its name (case-insensitive exact match, e.g. \"water\"). A count tracker appends one entry of `amount`; a check tracker marks `date` done (idempotent per day).",
			ResponseSummary: "The written log: count → {id, trackerId, at, amount}; check → {id, trackerId, date, done:true}.",
			Example:         `api.call("trackers.log", path_params={"tracker": "water"}, body={"amount": 2})`,
		},
		{
			ID:         "trackers.history",
			Topic:      "trackers",
			Method:     "GET",
			Path:       "/api/trackers/{id}/history",
			PathParams: []string{"id"},
			Risk:       RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days": {"type": "integer", "minimum": 1, "maximum": 366, "description": "Number of local days to return, ending today (default 30)."}
  }
}`),
			Description:     "Per-day totals for one tracker (id from trackers.list) over the last N local days, oldest first, empty days included.",
			ResponseSummary: "JSON array of {date: YYYY-MM-DD, total}: summed amounts for count trackers, 1/0 for check trackers.",
			ResponseExample: `[
  {"date": "2026-07-05", "total": 6},
  {"date": "2026-07-06", "total": 3}
]`,
			Example: `result = api.call("trackers.history", path_params={"id": "tracker-1783339200000_k3j9x2ab"}, params={"days": 7})
output(result)`,
		},
	}
}
