package main

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

// A sync push's tags land in the receipt and the proxied body is intact (bd med-sz4k.6.1).
func TestListenGateReceiveTagsSyncPush(t *testing.T) {
	g := &listenGate{}
	body := `{"ops":[{"record_type_tag":"note:1762430000000123","nonce":"bg==","ct":"Yw=="}]}`
	r := httptest.NewRequest("POST", "/api/sync/ops", strings.NewReader(body))
	g.receive(r)
	g.receive(httptest.NewRequest("GET", "/api/sync/ops?since=0", nil))
	if got := g.receipts[0].Tags; len(got) != 1 || got[0] != "note:1762430000000123" {
		t.Fatalf("tags = %v", got)
	}
	if g.receipts[1].Tags != nil {
		t.Fatalf("a GET got tags %v", g.receipts[1].Tags)
	}
	if rest, _ := io.ReadAll(r.Body); string(rest) != body {
		t.Fatalf("proxied body = %q", rest)
	}
}
