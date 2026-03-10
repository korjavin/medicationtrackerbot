package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestAuditBufferFlush(t *testing.T) {
	var mu sync.Mutex
	var receivedPayload AuditPayload
	var receivedSignature string

	// Create a test HTTP server to act as the bot endpoint
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &receivedPayload)

		mu.Lock()
		receivedSignature = r.Header.Get("X-Signature")
		mu.Unlock()

		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	secret := "test-secret"
	buffer := NewAuditBuffer(ts.URL, secret)

	now := time.Now()
	// Same data type, non-overlapping
	buffer.Record(AuditEvent{
		DataType:  "Vitals",
		StartDate: now.Add(-10 * 24 * time.Hour),
		EndDate:   now.Add(-5 * 24 * time.Hour),
	})
	buffer.Record(AuditEvent{
		DataType:  "Vitals",
		StartDate: now.Add(-3 * 24 * time.Hour),
		EndDate:   now.Add(-1 * 24 * time.Hour),
	})

	// Another data type, overlapping
	buffer.Record(AuditEvent{
		DataType:  "Weight",
		StartDate: now.Add(-15 * 24 * time.Hour),
		EndDate:   now.Add(-10 * 24 * time.Hour),
	})
	buffer.Record(AuditEvent{
		DataType:  "Weight",
		StartDate: now.Add(-12 * 24 * time.Hour),
		EndDate:   now.Add(-2 * 24 * time.Hour),
	})

	buffer.Flush()

	mu.Lock()
	defer mu.Unlock()

	// Verify buffer is empty
	if len(buffer.events) != 0 {
		t.Errorf("Expected buffer to be empty after flush, got %d events", len(buffer.events))
	}

	// Verify signature exists
	if receivedSignature == "" {
		t.Error("Expected X-Signature header")
	}

	// Verify payload merged correctly
	if len(receivedPayload.DataTypes) != 2 {
		t.Fatalf("Expected 2 merged data types, got %d", len(receivedPayload.DataTypes))
	}

	for _, dt := range receivedPayload.DataTypes {
		switch dt.Label {
		case "Vitals":
			expectedStart := now.Add(-10 * 24 * time.Hour)
			expectedEnd := now.Add(-1 * 24 * time.Hour)
			if !dt.From.Equal(expectedStart) {
				t.Errorf("Expected Vitals From %v, got %v", expectedStart, dt.From)
			}
			if !dt.To.Equal(expectedEnd) {
				t.Errorf("Expected Vitals To %v, got %v", expectedEnd, dt.To)
			}
		case "Weight":
			expectedStart := now.Add(-15 * 24 * time.Hour)
			expectedEnd := now.Add(-2 * 24 * time.Hour)
			if !dt.From.Equal(expectedStart) {
				t.Errorf("Expected Weight From %v, got %v", expectedStart, dt.From)
			}
			if !dt.To.Equal(expectedEnd) {
				t.Errorf("Expected Weight To %v, got %v", expectedEnd, dt.To)
			}
		default:
			t.Errorf("Unexpected data type label: %s", dt.Label)
		}
	}
}

func TestAuditBufferStart(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	buffer := NewAuditBuffer(ts.URL, "secret")
	ctx, cancel := context.WithCancel(context.Background())

	buffer.Record(AuditEvent{
		DataType:  "Test",
		StartDate: time.Now(),
		EndDate:   time.Now(),
	})

	buffer.Start(ctx)
	// Cancel immediately to trigger shutdown flush
	cancel()

	// Give goroutine time to finish
	time.Sleep(50 * time.Millisecond)

	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if len(buffer.events) != 0 {
		t.Error("Buffer should be empty after Start cancelled")
	}
}

func TestAuditBuffer_Disabled(t *testing.T) {
	// If secret is missing, it should handle graceful flush failure (or be disabled higher up)
	// But let's verify empty secret doesn't crash on flush
	buffer := NewAuditBuffer("http://localhost:1234", "")
	buffer.Record(AuditEvent{
		DataType:  "Test",
		StartDate: time.Now(),
		EndDate:   time.Now(),
	})

	// Should log error but not crash
	buffer.Flush()

	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if len(buffer.events) != 0 {
		t.Error("Buffer should still be cleared even if HTTP POST fails")
	}
}
