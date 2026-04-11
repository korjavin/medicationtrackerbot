package mcp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLogFood_Success(t *testing.T) {
	secret := "test-secret"
	expectedID := int64(42)
	payload := foodLogPayload{
		Name:     "Apple",
		EatenAt:  time.Now().Truncate(time.Second),
		Calories: 95,
		CarbsG:   25,
		ProteinG: 0,
		FatG:     0,
		WeightG:  182,
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify method
		if r.Method != http.MethodPost {
			t.Errorf("expected POST request, got %s", r.Method)
		}

		// Verify content type
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}

		// Read body
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("failed to read request body: %v", err)
		}

		// Verify signature
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		expectedSig := hex.EncodeToString(mac.Sum(nil))
		if r.Header.Get("X-Signature") != expectedSig {
			t.Errorf("expected X-Signature %s, got %s", expectedSig, r.Header.Get("X-Signature"))
		}

		// Verify payload
		var received foodLogPayload
		if err := json.Unmarshal(body, &received); err != nil {
			t.Fatalf("failed to unmarshal request body: %v", err)
		}
		if received.Name != payload.Name || !received.EatenAt.Equal(payload.EatenAt) {
			t.Errorf("received payload mismatch: %+v", received)
		}

		// Send response
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]int64{"id": expectedID})
	}))
	defer ts.Close()

	fw := NewFoodWriter(ts.URL, secret)
	id, err := fw.LogFood(context.Background(), payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if id != expectedID {
		t.Errorf("expected ID %d, got %d", expectedID, id)
	}
}

func TestLogFood_ErrorStatus(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("invalid request"))
	}))
	defer ts.Close()

	fw := NewFoodWriter(ts.URL, "secret")
	id, err := fw.LogFood(context.Background(), foodLogPayload{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	if id != 0 {
		t.Errorf("expected ID 0, got %d", id)
	}

	expectedErr := "food_writer: unexpected status 400: invalid request"
	if err.Error() != expectedErr {
		t.Errorf("expected error %q, got %q", expectedErr, err.Error())
	}
}

func TestLogFood_InvalidJSON(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("not json"))
	}))
	defer ts.Close()

	fw := NewFoodWriter(ts.URL, "secret")
	_, err := fw.LogFood(context.Background(), foodLogPayload{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	if !strings.Contains(err.Error(), "food_writer: decode response") {
		t.Errorf("expected decoding error, got %v", err)
	}
}

func TestLogFood_NetworkError(t *testing.T) {
	// Use an invalid URL to trigger a network error
	fw := NewFoodWriter("http://localhost:1", "secret")
	_, err := fw.LogFood(context.Background(), foodLogPayload{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	if !strings.Contains(err.Error(), "food_writer: request failed") {
		t.Errorf("expected request failure error, got %v", err)
	}
}
