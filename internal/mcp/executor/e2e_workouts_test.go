package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// TestE2E_ReadOnlyWorkouts_Workflow exercises the full vertical slice for
// Task 10: a script that lists groups, picks a variant, lists its exercises,
// and outputs a summary. The script never touches the database directly —
// every backend interaction goes through the loopback proxy → bridge chain.
//
// The bridge is faked so this test stays focused on the executor + proxy +
// registry plumbing; the live bridge has its own tests in
// internal/server/mcp_bridge_test.go.
func TestE2E_ReadOnlyWorkouts_Workflow(t *testing.T) {
	reg := registry.New()
	if err := reg.Register(registry.WorkoutOperations()...); err != nil {
		t.Fatalf("register workout ops: %v", err)
	}

	// Realistic stand-in data for the three operations the workflow uses.
	groupsBody := json.RawMessage(`[{"id":1,"name":"Gym A","is_rotating":true},{"id":2,"name":"Home","is_rotating":false}]`)
	variantsBody := json.RawMessage(`[{"id":10,"name":"Push Day","group_id":1},{"id":11,"name":"Pull Day","group_id":1}]`)
	exercisesBody := json.RawMessage(`[{"id":100,"name":"Bench Press","sets":3,"reps":8,"weight_kg":60,"variant_id":10},{"id":101,"name":"Overhead Press","sets":3,"reps":10,"weight_kg":40,"variant_id":10}]`)

	// Bridge mock: dispatch on operation_id from the BridgeRequest payload, so
	// the test mirrors how the real bridge looks up the op in the registry
	// before forwarding to the backend.
	type bridgeHit struct {
		opID  string
		query string
	}
	var (
		mu   sync.Mutex
		hits []bridgeHit
	)
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var br proxy.BridgeRequest
		if err := json.Unmarshal(body, &br); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		mu.Lock()
		hits = append(hits, bridgeHit{opID: br.OperationID, query: queryString(br.Params)})
		mu.Unlock()

		var respBody json.RawMessage
		switch br.OperationID {
		case "workouts.groups.list":
			respBody = groupsBody
		case "workouts.variants.list":
			respBody = variantsBody
		case "workouts.exercises.list":
			respBody = exercisesBody
		default:
			http.Error(w, "unhandled op", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{Status: 200, Body: respBody, DurationMS: 1})
	}))
	t.Cleanup(bridge.Close)

	// Spawner stands in for the runner subprocess. It mimics what a real user
	// script would do via medtracker.api.call: POST to the loopback proxy
	// URL with the X-Run-Token header, parse the JSON response, and chain.
	// This proves the workflow is achievable without any direct DB access.
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, fmt.Errorf("unmarshal payload: %w", err)
		}
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		// Step 1: list groups.
		groups, err := loopbackCall(ctx, proxyURL, token, "workouts.groups.list", nil)
		if err != nil {
			return nil, fmt.Errorf("groups: %w", err)
		}

		// Step 2: list variants for the first rotating group.
		var groupList []map[string]any
		if err := json.Unmarshal(groups, &groupList); err != nil {
			return nil, fmt.Errorf("decode groups: %w", err)
		}
		if len(groupList) == 0 {
			return nil, fmt.Errorf("no groups returned")
		}
		groupID := int(groupList[0]["id"].(float64))
		variants, err := loopbackCall(ctx, proxyURL, token, "workouts.variants.list", map[string]any{
			"group_id": groupID,
		})
		if err != nil {
			return nil, fmt.Errorf("variants: %w", err)
		}

		// Step 3: list exercises for the first variant.
		var variantList []map[string]any
		if err := json.Unmarshal(variants, &variantList); err != nil {
			return nil, fmt.Errorf("decode variants: %w", err)
		}
		if len(variantList) == 0 {
			return nil, fmt.Errorf("no variants returned")
		}
		variantID := int(variantList[0]["id"].(float64))
		variantName := variantList[0]["name"].(string)
		exercises, err := loopbackCall(ctx, proxyURL, token, "workouts.exercises.list", map[string]any{
			"variant_id": variantID,
		})
		if err != nil {
			return nil, fmt.Errorf("exercises: %w", err)
		}

		var exerciseList []map[string]any
		if err := json.Unmarshal(exercises, &exerciseList); err != nil {
			return nil, fmt.Errorf("decode exercises: %w", err)
		}

		summary := map[string]any{
			"group_id":       groupID,
			"group_name":     groupList[0]["name"],
			"variant_id":     variantID,
			"variant_name":   variantName,
			"exercise_count": len(exerciseList),
			"total_groups":   len(groupList),
			"total_variants": len(variantList),
		}
		summaryJSON, err := json.Marshal(summary)
		if err != nil {
			return nil, fmt.Errorf("marshal summary: %w", err)
		}
		return envelopeOK(string(summaryJSON)), nil
	}}

	o := Options{
		Registry:   reg,
		BridgeURL:  bridge.URL,
		HMACSecret: "e2e-secret",
		Spawner:    sp,
	}
	svc, err := New(o)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := svc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = svc.Shutdown(context.Background()) })

	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:         "# would import medtracker and chain api.call() three times",
		Mode:           proxy.ModeReadOnly,
		TimeoutMS:      5000,
		MaxAPICalls:    10,
		TopicAllowlist: []string{"workouts"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusOK {
		t.Fatalf("expected status %q, got %q (error: %s)", mcp.ExecuteStatusOK, res.Status, res.Error)
	}

	// The summary must contain the data threaded across the three calls,
	// proving the workflow actually composed responses (not just one call).
	var summary map[string]any
	if err := json.Unmarshal(res.Result, &summary); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if summary["group_name"] != "Gym A" {
		t.Errorf("expected group_name=Gym A, got %v", summary["group_name"])
	}
	if summary["variant_name"] != "Push Day" {
		t.Errorf("expected variant_name=Push Day, got %v", summary["variant_name"])
	}
	if int(summary["exercise_count"].(float64)) != 2 {
		t.Errorf("expected exercise_count=2, got %v", summary["exercise_count"])
	}

	// The audit/call trace must include every proxied operation ID, in the
	// order the script issued them. This is the contract Task 10 calls out:
	// every backend hop is observable from the executor side.
	mu.Lock()
	defer mu.Unlock()
	if len(hits) != 3 {
		t.Fatalf("expected 3 bridge hits, got %d: %+v", len(hits), hits)
	}
	wantOrder := []string{
		"workouts.groups.list",
		"workouts.variants.list",
		"workouts.exercises.list",
	}
	for i, want := range wantOrder {
		if hits[i].opID != want {
			t.Errorf("hit %d: expected operation %q, got %q", i, want, hits[i].opID)
		}
	}
	if !strings.Contains(hits[1].query, "group_id=1") {
		t.Errorf("variants call missing group_id param, got query %q", hits[1].query)
	}
	if !strings.Contains(hits[2].query, "variant_id=10") {
		t.Errorf("exercises call missing variant_id param, got query %q", hits[2].query)
	}

	// CallCount on the proxy is what the executor reports as APICalls — assert
	// it matches the three operations we threaded through.
	if res.APICalls != 3 {
		t.Errorf("expected APICalls=3, got %d", res.APICalls)
	}
}

// TestE2E_ReadOnlyWorkouts_NoDirectDBAccess sanity-checks that the workout
// helper operations are read-only and route through the proxy boundary; a
// script can never reach the DB without going via an op the registry permits.
func TestE2E_ReadOnlyWorkouts_NoDirectDBAccess(t *testing.T) {
	reg := registry.New()
	if err := reg.Register(registry.WorkoutOperations()...); err != nil {
		t.Fatalf("register: %v", err)
	}

	for _, id := range []string{
		"workouts.groups.list",
		"workouts.variants.list",
		"workouts.exercises.list",
		"workouts.sessions.list",
		"workouts.sessions.details",
		"workouts.stats.read",
	} {
		op := reg.Get(id)
		if op == nil {
			t.Errorf("missing op %s", id)
			continue
		}
		if op.Risk != registry.RiskRead {
			t.Errorf("op %s: expected risk=read, got %s", id, op.Risk)
		}
		if !strings.HasPrefix(op.Path, "/api/workout/") {
			t.Errorf("op %s: expected /api/workout/* path, got %s", id, op.Path)
		}
	}

	// A script that tries to use a non-registered path is rejected by the
	// proxy before it ever reaches the bridge — proving the registry is the
	// single gate. We exercise this by making a proxy-level call directly.
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("bridge should never be hit for unknown ops")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(bridge.Close)

	p := proxy.New(reg, bridge.URL, "secret")
	_, err := p.Call(context.Background(), proxy.RunConfig{Mode: proxy.ModeReadOnly}, "workouts.raw_sql", nil, nil)
	if err == nil {
		t.Fatal("expected proxy to reject unknown op")
	}
	var ce *proxy.CallError
	if !errorsAs(err, &ce) || ce.Code != proxy.ErrUnknownOperation {
		t.Errorf("expected unknown_operation error, got %v", err)
	}
}

// loopbackCall posts to the executor's loopback /call endpoint exactly the way
// a real user script would via medtracker.api.call. It returns the raw
// response body the bridge produced (i.e. the backend payload) so the
// "script" can chain calls.
func loopbackCall(ctx context.Context, proxyURL, token, opID string, params map[string]any) ([]byte, error) {
	payload := map[string]any{"operation_id": opID}
	if params != nil {
		// The proxy's BridgeRequest.Params is map[string]string; serialize as
		// strings so the bridge URL-encodes them. The runner does the same.
		strParams := make(map[string]string, len(params))
		for k, v := range params {
			strParams[k] = fmt.Sprintf("%v", v)
		}
		payload["params"] = strParams
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Run-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("loopback returned %d: %s", resp.StatusCode, respBody)
	}
	return respBody, nil
}

func queryString(params map[string]string) string {
	if len(params) == 0 {
		return ""
	}
	parts := make([]string, 0, len(params))
	for k, v := range params {
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, "&")
}

// errorsAs is a tiny shim so we don't need to import "errors" in a file that
// already depends on the proxy package. It mirrors errors.As semantics for
// the single concrete pointer case used here.
func errorsAs(err error, target **proxy.CallError) bool {
	if err == nil {
		return false
	}
	if ce, ok := err.(*proxy.CallError); ok {
		*target = ce
		return true
	}
	return false
}
