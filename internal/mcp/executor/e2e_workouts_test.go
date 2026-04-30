package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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

// TestE2E_WriteMode_WorkoutExerciseUpdate exercises the first registered
// write op (workouts.exercises.update). The script reads the variant's
// exercises, picks one, and PUTs an updated payload — proving:
//   - mode="write" is enabled end-to-end
//   - the proxy classifies the op as a write and forwards it
//   - intent flows to the executor and lands in the audit log
//   - the bridge call reaches the configured backend handler with method/path
//     matching the registry, and the body is forwarded as JSON
func TestE2E_WriteMode_WorkoutExerciseUpdate(t *testing.T) {
	reg := registry.New()
	if err := reg.Register(registry.WorkoutOperations()...); err != nil {
		t.Fatalf("register workout ops: %v", err)
	}

	// The bridge stand-in mirrors the real bridge contract: it accepts a
	// signed BridgeRequest, dispatches by operation_id, and returns a
	// BridgeResponse envelope. The variants/exercises results are static
	// stand-ins; the update handler captures the inbound payload so we can
	// assert the script-supplied body actually reaches the backend.
	exercisesBody := json.RawMessage(`[{"id":100,"name":"Bench Press","sets":3,"reps":8,"weight_kg":60,"variant_id":10}]`)

	type updateCall struct {
		params map[string]string
		body   json.RawMessage
	}
	var (
		mu      sync.Mutex
		updates []updateCall
		hits    []string
	)
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var br proxy.BridgeRequest
		if err := json.Unmarshal(raw, &br); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		mu.Lock()
		hits = append(hits, br.OperationID)
		mu.Unlock()

		switch br.OperationID {
		case "workouts.exercises.list":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{Status: 200, Body: exercisesBody})
		case "workouts.exercises.update":
			mu.Lock()
			updates = append(updates, updateCall{params: br.Params, body: br.Body})
			mu.Unlock()
			// Backend domain validation in the real handler returns an empty
			// body on success; mirror that behavior here.
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{Status: 200, Body: json.RawMessage(`{}`)})
		default:
			http.Error(w, "unhandled op: "+br.OperationID, http.StatusInternalServerError)
		}
	}))
	t.Cleanup(bridge.Close)

	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, fmt.Errorf("unmarshal payload: %w", err)
		}
		// Sanity-check that the executor forwarded the intent into the
		// runner config; the runner doesn't need it for execution but the
		// audit chain depends on it being present.
		if intent, _ := p["intent"].(string); intent != "rebalance bench press volume" {
			return nil, fmt.Errorf("intent missing from runner payload: %v", p["intent"])
		}
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		// Step 1: list exercises for variant 10.
		exercises, err := loopbackCall(ctx, proxyURL, token, "workouts.exercises.list", map[string]any{
			"variant_id": 10,
		})
		if err != nil {
			return nil, fmt.Errorf("list exercises: %w", err)
		}
		var list []map[string]any
		if err := json.Unmarshal(exercises, &list); err != nil {
			return nil, fmt.Errorf("decode exercises: %w", err)
		}
		if len(list) == 0 {
			return nil, fmt.Errorf("no exercises returned")
		}
		exerciseID := int(list[0]["id"].(float64))

		// Step 2: PUT updated config for that exercise via the write op.
		updateBody := map[string]any{
			"exercise_name":    "Bench Press",
			"target_sets":      4,
			"target_reps_min":  6,
			"target_reps_max":  8,
			"target_weight_kg": 65.0,
			"order_index":      0,
		}
		_, status, err := loopbackCallStatus(ctx, proxyURL, token, "workouts.exercises.update",
			map[string]any{"id": exerciseID}, updateBody)
		if err != nil {
			return nil, fmt.Errorf("update exercise: %w", err)
		}
		if status != http.StatusOK {
			return nil, fmt.Errorf("update returned status %d", status)
		}

		summary := map[string]any{"updated_id": exerciseID}
		raw, _ := json.Marshal(summary)
		return envelopeOK(string(raw)), nil
	}}

	// Capture slog records so we can assert intent appears in audit metadata.
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	prev := slog.Default()
	slog.SetDefault(logger)
	t.Cleanup(func() { slog.SetDefault(prev) })

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
		Script:         "# real script would chain api.call(...) for read+write",
		Mode:           proxy.ModeWrite,
		Intent:         "rebalance bench press volume",
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

	// The bridge must have seen both the read and the write hop, in order.
	mu.Lock()
	defer mu.Unlock()
	if len(hits) != 2 {
		t.Fatalf("expected 2 bridge hits, got %d: %v", len(hits), hits)
	}
	if hits[0] != "workouts.exercises.list" || hits[1] != "workouts.exercises.update" {
		t.Errorf("unexpected hit order: %v", hits)
	}

	// The write op must have arrived with both the params and the body the
	// script supplied — proving the proxy forwards body bytes through the
	// bridge unchanged.
	if len(updates) != 1 {
		t.Fatalf("expected 1 update call, got %d", len(updates))
	}
	if updates[0].params["id"] != "100" {
		t.Errorf("expected params[id]=100, got %v", updates[0].params)
	}
	var got map[string]any
	if err := json.Unmarshal(updates[0].body, &got); err != nil {
		t.Fatalf("decode update body: %v", err)
	}
	if got["exercise_name"] != "Bench Press" {
		t.Errorf("expected exercise_name=Bench Press, got %v", got["exercise_name"])
	}
	if got["target_sets"].(float64) != 4 {
		t.Errorf("expected target_sets=4, got %v", got["target_sets"])
	}

	// Audit log must include the intent string for write runs.
	logs := logBuf.String()
	if !strings.Contains(logs, "rebalance bench press volume") {
		t.Errorf("expected slog audit to contain intent string, got: %s", logs)
	}
	if !strings.Contains(logs, `"mode":"write"`) {
		t.Errorf("expected slog audit to record mode=write, got: %s", logs)
	}

	if res.APICalls != 2 {
		t.Errorf("expected APICalls=2 (one read, one write), got %d", res.APICalls)
	}
}

// TestE2E_WriteInReadOnly_RejectedByProxy verifies that an accidental write
// attempt from a read_only run hits the proxy boundary and gets rejected with
// 403 — the helper-side code path that surfaces as ProxyDenied. The bridge
// must never see the write attempt.
func TestE2E_WriteInReadOnly_RejectedByProxy(t *testing.T) {
	reg := registry.New()
	if err := reg.Register(registry.WorkoutOperations()...); err != nil {
		t.Fatalf("register workout ops: %v", err)
	}

	var bridgeHits int
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		bridgeHits++
		t.Errorf("bridge must never be hit when proxy denies the write; bridgeHits=%d", bridgeHits)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(bridge.Close)

	var observedStatus int
	var observedBody []byte
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		// Attempt a write op while running in read_only mode.
		body, status, err := loopbackCallStatus(ctx, proxyURL, token, "workouts.exercises.update",
			map[string]any{"id": 1},
			map[string]any{
				"exercise_name":   "x",
				"target_sets":     1,
				"target_reps_min": 1,
				"order_index":     0,
			})
		if err != nil {
			return nil, fmt.Errorf("loopback call: %w", err)
		}
		observedStatus = status
		observedBody = body

		// Surface as a script error so the executor's mapping path is exercised.
		// In real life medtracker.api.call would raise ProxyDenied; here we
		// fabricate the equivalent envelope. The runner records the fully
		// qualified type so the executor can distinguish the helper exception
		// from a same-name user class.
		return envelopeError("script_error", "medtracker.exceptions.ProxyDenied", "write_blocked: operation requires write mode"), nil
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
		Script:    "# would call api.call('workouts.exercises.update', ...) in read_only",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if observedStatus != http.StatusForbidden {
		t.Errorf("expected loopback to return 403, got %d (body: %s)", observedStatus, observedBody)
	}
	if !strings.Contains(string(observedBody), "write_blocked") {
		t.Errorf("expected response body to contain write_blocked, got: %s", observedBody)
	}
	if res.Status != mcp.ExecuteStatusProxyDenied {
		t.Errorf("expected MCP status %q, got %q", mcp.ExecuteStatusProxyDenied, res.Status)
	}
	if bridgeHits != 0 {
		t.Errorf("bridge must not be hit for proxy-denied writes, hits=%d", bridgeHits)
	}
}

// loopbackCall posts to the executor's loopback /call endpoint exactly the way
// a real user script would via medtracker.api.call. It returns the raw
// response body the bridge produced (i.e. the backend payload) so the
// "script" can chain calls.
func loopbackCall(ctx context.Context, proxyURL, token, opID string, params map[string]any) ([]byte, error) {
	respBody, status, err := loopbackCallStatus(ctx, proxyURL, token, opID, params, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("loopback returned %d: %s", status, respBody)
	}
	return respBody, nil
}

// loopbackCallStatus posts to the loopback /call endpoint and returns both the
// response body and HTTP status code. Used by write-mode tests that need to
// inspect non-200 responses (e.g. 403 for proxy_denied), and by callers that
// need to send a request body (e.g. PUT/POST writes).
func loopbackCallStatus(ctx context.Context, proxyURL, token, opID string, params map[string]any, reqBody any) ([]byte, int, error) {
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
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal body: %w", err)
		}
		payload["body"] = json.RawMessage(raw)
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Run-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, nil
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
