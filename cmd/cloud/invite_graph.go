package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// adminInviteGraph prints the invitation forest. Optional --format=tree|dot|json
// (default tree). Unknown format → usage on stderr + exit 1.
func adminInviteGraph(ctx context.Context, store *cloudstore.Repo, args []string) int {
	format := "tree"
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--format="); ok {
			format = v
			continue
		}
		fmt.Fprintf(os.Stderr, "invite-graph: unknown argument %q\n", a)
		return 1
	}

	nodes, err := store.ListAccountsForGraph(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invite-graph failed: %v\n", err)
		return 1
	}

	switch format {
	case "tree":
		roots, orphans := buildInviteForest(nodes)
		fmt.Print(renderTree(roots, orphans))
	case "dot":
		fmt.Print(renderDOT(nodes))
	case "json":
		out, err := renderJSON(nodes)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invite-graph: render json: %v\n", err)
			return 1
		}
		fmt.Println(string(out))
	default:
		fmt.Fprintf(os.Stderr, "invite-graph: unknown format %q (want tree|dot|json)\n", format)
		return 1
	}
	return 0
}

// forestNode is a single account plus its invitees, used to render the
// invitation forest reconstructed from accounts.created_by_account_id.
type forestNode struct {
	cloudstore.AccountGraphNode
	Children []*forestNode
}

// buildInviteForest partitions accounts into roots (admin-CLI mints, CreatedBy
// == nil) and orphans (CreatedBy set but pointing at an account no longer
// present — its inviter was deleted). Every other node is attached to its
// parent's Children. Children are sorted by CreatedAt then Subdomain so output
// is deterministic.
func buildInviteForest(nodes []cloudstore.AccountGraphNode) (roots []*forestNode, orphans []*forestNode) {
	byID := make(map[string]*forestNode, len(nodes))
	for i := range nodes {
		n := &forestNode{AccountGraphNode: nodes[i]}
		byID[n.ID] = n
	}

	for _, n := range byID {
		switch {
		case n.CreatedBy == nil:
			roots = append(roots, n)
		case byID[*n.CreatedBy] != nil:
			parent := byID[*n.CreatedBy]
			parent.Children = append(parent.Children, n)
		default:
			orphans = append(orphans, n)
		}
	}

	// A created_by cycle (or self-reference) leaves a node attached to a parent
	// but never reachable from a root — provenance shouldn't cycle, but corrupt
	// data must not vanish silently. Surface any such node as an orphan so it
	// still renders (the walk's visited-guard bounds the recursion).
	reached := make(map[string]bool, len(byID))
	var mark func(n *forestNode)
	mark = func(n *forestNode) {
		if reached[n.ID] {
			return
		}
		reached[n.ID] = true
		for _, c := range n.Children {
			mark(c)
		}
	}
	for _, r := range roots {
		mark(r)
	}
	for _, o := range orphans {
		mark(o)
	}
	for _, n := range byID {
		if !reached[n.ID] {
			orphans = append(orphans, n)
		}
	}

	sortNodes(roots)
	sortNodes(orphans)
	for _, n := range byID {
		sortNodes(n.Children)
	}
	return roots, orphans
}

func sortNodes(ns []*forestNode) {
	sort.Slice(ns, func(i, j int) bool {
		if !ns[i].CreatedAt.Equal(ns[j].CreatedAt) {
			return ns[i].CreatedAt.Before(ns[j].CreatedAt)
		}
		return ns[i].Subdomain < ns[j].Subdomain
	})
}

func claimLabel(claimed bool) string {
	if claimed {
		return "claimed"
	}
	return "pending"
}

// renderTree draws the forest as an ASCII tree. Orphan subtrees (whose inviter
// was deleted) render under a clearly-labelled section so they stay visible.
func renderTree(roots, orphans []*forestNode) string {
	if len(roots) == 0 && len(orphans) == 0 {
		return "no accounts\n"
	}
	var b strings.Builder
	for _, r := range roots {
		writeTreeNode(&b, r, "", "", map[string]bool{})
	}
	if len(orphans) > 0 {
		b.WriteString("\norphaned (inviter deleted):\n")
		for _, o := range orphans {
			writeTreeNode(&b, o, "", "", map[string]bool{})
		}
	}
	return b.String()
}

func nodeLabel(n *forestNode) string {
	return fmt.Sprintf("%s [%s] created=%s", n.Subdomain, claimLabel(n.Claimed), n.CreatedAt.Format("2006-01-02"))
}

// writeTreeNode prints one node (prefix+branch+label) then recurses into its
// children. branch is "" for a forest root/orphan entry point and "├── "/"└── "
// for a child. visited guards a cyclic CreatedBy chain so a self/loop reference
// can't infinite-loop the walk.
func writeTreeNode(b *strings.Builder, n *forestNode, prefix, branch string, visited map[string]bool) {
	b.WriteString(prefix + branch)
	b.WriteString(nodeLabel(n))
	b.WriteByte('\n')
	if visited[n.ID] {
		return
	}
	visited[n.ID] = true
	childPrefix := prefix
	switch branch {
	case "├── ":
		childPrefix += "│   "
	case "└── ":
		childPrefix += "    "
	}
	for i, c := range n.Children {
		cb := "├── "
		if i == len(n.Children)-1 {
			cb = "└── "
		}
		writeTreeNode(b, c, childPrefix, cb, visited)
	}
	delete(visited, n.ID)
}

// renderDOT emits a Graphviz digraph using subdomains as node ids. Pending
// (unclaimed) accounts are drawn dashed. Edges only for resolvable inviters.
func renderDOT(nodes []cloudstore.AccountGraphNode) string {
	byID := make(map[string]string, len(nodes)) // account id -> subdomain
	for _, n := range nodes {
		byID[n.ID] = n.Subdomain
	}

	var b strings.Builder
	b.WriteString("digraph invites {\n")
	for _, n := range nodes {
		if n.Claimed {
			fmt.Fprintf(&b, "  %q [label=%q];\n", n.Subdomain, n.Subdomain)
		} else {
			fmt.Fprintf(&b, "  %q [label=%q, style=dashed];\n", n.Subdomain, n.Subdomain)
		}
	}
	for _, n := range nodes {
		if n.CreatedBy == nil {
			continue
		}
		if inviter, ok := byID[*n.CreatedBy]; ok {
			fmt.Fprintf(&b, "  %q -> %q;\n", inviter, n.Subdomain)
		}
	}
	b.WriteString("}\n")
	return b.String()
}

type jsonNode struct {
	ID        string `json:"id"`
	Subdomain string `json:"subdomain"`
	Claimed   bool   `json:"claimed"`
	CreatedAt string `json:"created_at"`
}

type jsonEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// renderJSON emits {nodes, edges}. Edges only for inviters present in the set;
// ordering follows the input (which the store already sorts).
func renderJSON(nodes []cloudstore.AccountGraphNode) ([]byte, error) {
	present := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		present[n.ID] = true
	}

	out := struct {
		Nodes []jsonNode `json:"nodes"`
		Edges []jsonEdge `json:"edges"`
	}{Nodes: []jsonNode{}, Edges: []jsonEdge{}}

	for _, n := range nodes {
		out.Nodes = append(out.Nodes, jsonNode{
			ID:        n.ID,
			Subdomain: n.Subdomain,
			Claimed:   n.Claimed,
			CreatedAt: n.CreatedAt.Format("2006-01-02"),
		})
		if n.CreatedBy != nil && present[*n.CreatedBy] {
			out.Edges = append(out.Edges, jsonEdge{From: *n.CreatedBy, To: n.ID})
		}
	}
	return json.MarshalIndent(out, "", "  ")
}
