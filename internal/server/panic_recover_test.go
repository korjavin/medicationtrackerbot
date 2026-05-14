package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPanicRecover_RespondsWith500WhenHeadersNotWritten(t *testing.T) {
	h := panicRecover(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	req := httptest.NewRequest(http.MethodGet, "/explode", nil)
	rr := httptest.NewRecorder()

	// Must not propagate the panic.
	h.ServeHTTP(rr, req)

	if got, want := rr.Code, http.StatusInternalServerError; got != want {
		t.Fatalf("status: got %d, want %d", got, want)
	}
	body := rr.Body.String()
	if strings.TrimSpace(body) == "" {
		t.Fatalf("body was empty; expected non-empty 500 response")
	}
}

func TestPanicRecover_DoesNotRewriteHeadersWhenAlreadyStreaming(t *testing.T) {
	h := panicRecover(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := io.WriteString(w, "partial-payload"); err != nil {
			t.Fatalf("write before panic failed: %v", err)
		}
		panic("mid-stream boom")
	}))

	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if got, want := rr.Code, http.StatusOK; got != want {
		t.Fatalf("status: got %d, want %d (must preserve already-sent status)", got, want)
	}
	if !strings.Contains(rr.Body.String(), "partial-payload") {
		t.Fatalf("body must preserve already-streamed bytes; got %q", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "internal error") {
		t.Fatalf("body must not contain rewritten 500 message after streaming started; got %q", rr.Body.String())
	}
}

func TestPanicRecover_PassesThroughNonPanicResponses(t *testing.T) {
	h := panicRecover(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, "ok")
	}))

	req := httptest.NewRequest(http.MethodGet, "/ok", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if got, want := rr.Code, http.StatusTeapot; got != want {
		t.Fatalf("status: got %d, want %d", got, want)
	}
	if rr.Body.String() != "ok" {
		t.Fatalf("body: got %q, want %q", rr.Body.String(), "ok")
	}
}

func TestPanicRecover_RePanicsOnErrAbortHandler(t *testing.T) {
	defer func() {
		if r := recover(); r != http.ErrAbortHandler {
			t.Fatalf("expected http.ErrAbortHandler to propagate, got %v", r)
		}
	}()

	h := panicRecover(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	req := httptest.NewRequest(http.MethodGet, "/abort", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	t.Fatal("expected re-panic from ErrAbortHandler")
}
