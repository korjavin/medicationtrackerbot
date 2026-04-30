package proxy

import "strconv"

// paramBound describes the allowed range for an integer query parameter.
// Min is the smallest accepted positive value; values <= 0 or unparseable
// values are replaced with DefaultValue. Max=0 means "use the proxy
// MaxQueryDays cap"; this is only meaningful for the lookback "days"
// parameter on list operations.
type paramBound struct {
	DefaultValue int
	Min          int
	Max          int
}

// listOpParamBounds maps operation IDs that fan out to potentially-large
// rowsets to per-param clamping policy applied by the proxy before the call
// reaches the backend. The granular MCP tools cap reads via Server.MaxQueryDays;
// the executor path must mirror that cap so mcp_execute cannot bypass the
// configured data window by passing days=0 or limit=0.
var listOpParamBounds = map[string]map[string]paramBound{
	"health.bp.list": {
		"days":  {DefaultValue: 30, Min: 1, Max: 0},
		"limit": {DefaultValue: 100, Min: 1, Max: 5000},
	},
	"health.weight.list": {
		"days":  {DefaultValue: 30, Min: 1, Max: 0},
		"limit": {DefaultValue: 100, Min: 1, Max: 5000},
	},
	"medications.history": {
		"days": {DefaultValue: 3, Min: 1, Max: 0},
	},
	"health.notes.list": {
		"days":  {DefaultValue: 30, Min: 1, Max: 0},
		"limit": {DefaultValue: 50, Min: 1, Max: 200},
	},
	"food.log.list": {
		"days": {DefaultValue: 1, Min: 1, Max: 0},
	},
	"food.stats.read": {
		"days": {DefaultValue: 7, Min: 1, Max: 0},
	},
	"workouts.sessions.list": {
		"limit": {DefaultValue: 30, Min: 1, Max: 500},
	},
}

// clampListParams normalizes integer query parameters for list operations
// against the policy in listOpParamBounds. Operations not in the map are
// returned unchanged. Missing or non-positive values are replaced with the
// documented default; out-of-range values are clamped down to the cap.
//
// maxQueryDays caps the "days" lookback. A value of 0 disables the days cap
// (the only documented use is in tests that don't configure the proxy).
func clampListParams(opID string, params map[string]string, maxQueryDays int) map[string]string {
	bounds, ok := listOpParamBounds[opID]
	if !ok {
		return params
	}
	if params == nil {
		params = make(map[string]string, len(bounds))
	}
	for name, b := range bounds {
		max := b.Max
		if max == 0 {
			max = maxQueryDays
		}
		raw, present := params[name]
		v, err := strconv.Atoi(raw)
		if !present || err != nil || v < b.Min {
			v = b.DefaultValue
		}
		if max > 0 && v > max {
			v = max
		}
		params[name] = strconv.Itoa(v)
	}
	return params
}
