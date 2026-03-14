package main

import (
	"net/http"
	"testing"
	"time"
)

func TestServerConfig(t *testing.T) {
	srv := newHTTPServer(":8080", http.NewServeMux())

	if srv.ReadTimeout != 15*time.Second {
		t.Fatalf("expected ReadTimeout=15s, got %v", srv.ReadTimeout)
	}

	if srv.ReadHeaderTimeout != 10*time.Second {
		t.Fatalf("expected ReadHeaderTimeout=10s, got %v", srv.ReadHeaderTimeout)
	}

	if srv.WriteTimeout != 45*time.Second {
		t.Fatalf("expected WriteTimeout=45s, got %v", srv.WriteTimeout)
	}

	if srv.MaxHeaderBytes != 1<<20 {
		t.Fatalf("expected MaxHeaderBytes=1<<20, got %d", srv.MaxHeaderBytes)
	}

	if srv.Addr != ":8080" {
		t.Fatalf("expected Addr=:8080, got %s", srv.Addr)
	}
	if srv.Handler == nil {
		t.Fatal("expected Handler to be initialized")
	}
}
