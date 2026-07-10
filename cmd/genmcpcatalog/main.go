// Command genmcpcatalog renders internal/mcp/registry.DefaultOperations() into
// the browser-ESM catalog served by cloud mode's in-tab MCP responder.
//
// Usage: go run ./cmd/genmcpcatalog [-out path]
package main

import (
	"flag"
	"log/slog"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/catalogjs"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

func main() {
	out := flag.String("out", "web/cloud/js/mcp-catalog.generated.js", "output path for the generated catalog")
	flag.Parse()

	src, err := catalogjs.Generate(registry.DefaultOperations())
	if err != nil {
		slog.Error("generate catalog", "error", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, src, 0o644); err != nil {
		slog.Error("write catalog", "path", *out, "error", err)
		os.Exit(1)
	}
	slog.Info("wrote cloud MCP catalog", "path", *out, "bytes", len(src))
}
