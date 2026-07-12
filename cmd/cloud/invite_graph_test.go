package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func newGraphStore(t *testing.T) *cloudstore.Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := cloudstore.New(d)
	if err != nil {
		t.Fatalf("cloudstore.New: %v", err)
	}
	return r
}

// mkAccount creates a fixture account. A nil claimHash stores NULL
// claim_token_hash → Claimed=true; a non-nil hash → pending invite.
func mkAccount(t *testing.T, r *cloudstore.Repo, id, subdomain string, claimed bool, createdAt time.Time, createdBy string) {
	t.Helper()
	var hash []byte
	if !claimed {
		hash = []byte("pending-claim-token-hash-" + id)
	}
	if _, err := r.CreateAccount(context.Background(), id, subdomain, hash, createdAt.Add(14*24*time.Hour), createdAt, "", "", createdBy); err != nil {
		t.Fatalf("CreateAccount %s: %v", id, err)
	}
}

func ptr(s string) *string { return &s }

func TestInviteGraph_Forest(t *testing.T) {
	r := newGraphStore(t)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	// Two roots (admin mints), nested invitees, a pending invite, an orphan.
	mkAccount(t, r, "root1", "alpha-root", true, base, "")
	mkAccount(t, r, "root2", "bravo-root", true, base.Add(time.Minute), "")
	mkAccount(t, r, "child-a", "charlie-child", true, base.Add(2*time.Minute), "root1")
	mkAccount(t, r, "grand-a", "delta-grand", false, base.Add(3*time.Minute), "child-a") // pending
	mkAccount(t, r, "child-b", "echo-child", true, base.Add(4*time.Minute), "root2")
	mkAccount(t, r, "orphan", "foxtrot-orphan", true, base.Add(5*time.Minute), "deleted-inviter")

	nodes, err := r.ListAccountsForGraph(ctx)
	if err != nil {
		t.Fatalf("ListAccountsForGraph: %v", err)
	}
	if len(nodes) != 6 {
		t.Fatalf("expected 6 nodes, got %d", len(nodes))
	}

	roots, orphans := buildInviteForest(nodes)
	if len(roots) != 2 {
		t.Fatalf("expected 2 roots, got %d", len(roots))
	}
	if roots[0].Subdomain != "alpha-root" || roots[1].Subdomain != "bravo-root" {
		t.Fatalf("unexpected root order: %s, %s", roots[0].Subdomain, roots[1].Subdomain)
	}
	if len(orphans) != 1 || orphans[0].Subdomain != "foxtrot-orphan" {
		t.Fatalf("expected 1 orphan foxtrot-orphan, got %+v", orphans)
	}

	// root1 -> child-a -> grand-a
	if len(roots[0].Children) != 1 || roots[0].Children[0].Subdomain != "charlie-child" {
		t.Fatalf("expected root1 child charlie-child, got %+v", roots[0].Children)
	}
	if len(roots[0].Children[0].Children) != 1 || roots[0].Children[0].Children[0].Subdomain != "delta-grand" {
		t.Fatalf("expected charlie-child child delta-grand, got %+v", roots[0].Children[0].Children)
	}
	// root2 -> child-b
	if len(roots[1].Children) != 1 || roots[1].Children[0].Subdomain != "echo-child" {
		t.Fatalf("expected root2 child echo-child, got %+v", roots[1].Children)
	}

	tree := renderTree(roots, orphans)
	for _, want := range []string{
		"alpha-root [claimed]",
		"charlie-child [claimed]",
		"delta-grand [pending]",
		"echo-child [claimed]",
		"orphaned (inviter deleted):",
		"foxtrot-orphan [claimed]",
	} {
		if !strings.Contains(tree, want) {
			t.Errorf("tree missing %q\n%s", want, tree)
		}
	}
	// Nesting: grandchild is indented under its parent's connector.
	if !strings.Contains(tree, "└── delta-grand") && !strings.Contains(tree, "├── delta-grand") {
		t.Errorf("tree missing connector for delta-grand:\n%s", tree)
	}

	dot := renderDOT(nodes)
	for _, want := range []string{
		"digraph invites {",
		`"alpha-root" -> "charlie-child";`,
		`"charlie-child" -> "delta-grand";`,
		`"bravo-root" -> "echo-child";`,
		`"delta-grand" [label="delta-grand", style=dashed];`,
	} {
		if !strings.Contains(dot, want) {
			t.Errorf("dot missing %q\n%s", want, dot)
		}
	}
	// Orphan's dangling inviter must NOT produce an edge.
	if strings.Contains(dot, "deleted-inviter") {
		t.Errorf("dot should not reference deleted inviter:\n%s", dot)
	}

	out, err := renderJSON(nodes)
	if err != nil {
		t.Fatalf("renderJSON: %v", err)
	}
	var parsed struct {
		Nodes []struct {
			ID        string `json:"id"`
			Subdomain string `json:"subdomain"`
			Claimed   bool   `json:"claimed"`
			CreatedAt string `json:"created_at"`
		} `json:"nodes"`
		Edges []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"edges"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("unmarshal json: %v", err)
	}
	if len(parsed.Nodes) != 6 {
		t.Fatalf("expected 6 json nodes, got %d", len(parsed.Nodes))
	}
	// Edges only for resolvable inviters — orphan excluded → 3 edges.
	if len(parsed.Edges) != 3 {
		t.Fatalf("expected 3 json edges, got %d: %+v", len(parsed.Edges), parsed.Edges)
	}
}

func TestInviteGraph_CycleGuard(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	// Hand-built self-referential node: its own child points back to itself.
	n := &forestNode{AccountGraphNode: cloudstore.AccountGraphNode{
		ID: "loop", Subdomain: "loop-node", CreatedBy: ptr("loop"), CreatedAt: base, Claimed: true,
	}}
	n.Children = []*forestNode{n}

	done := make(chan string, 1)
	go func() { done <- renderTree([]*forestNode{n}, nil) }()
	select {
	case tree := <-done:
		if !strings.Contains(tree, "loop-node") {
			t.Errorf("expected loop-node in output:\n%s", tree)
		}
		// Guard stops recursion: label appears a bounded number of times, not ∞.
		if got := strings.Count(tree, "loop-node"); got > 3 {
			t.Errorf("cycle guard failed, loop-node appeared %d times:\n%s", got, tree)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("renderTree did not terminate on cyclic input")
	}
}

func TestInviteGraph_Empty(t *testing.T) {
	r := newGraphStore(t)
	nodes, err := r.ListAccountsForGraph(context.Background())
	if err != nil {
		t.Fatalf("ListAccountsForGraph: %v", err)
	}
	if len(nodes) != 0 {
		t.Fatalf("expected empty store, got %d nodes", len(nodes))
	}

	roots, orphans := buildInviteForest(nodes)
	if tree := renderTree(roots, orphans); tree != "no accounts\n" {
		t.Errorf("expected %q, got %q", "no accounts\n", tree)
	}

	out, err := renderJSON(nodes)
	if err != nil {
		t.Fatalf("renderJSON: %v", err)
	}
	var parsed struct {
		Nodes []json.RawMessage `json:"nodes"`
		Edges []json.RawMessage `json:"edges"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("unmarshal json: %v", err)
	}
	if len(parsed.Nodes) != 0 || len(parsed.Edges) != 0 {
		t.Fatalf("expected 0 nodes/edges, got %d/%d", len(parsed.Nodes), len(parsed.Edges))
	}
}
