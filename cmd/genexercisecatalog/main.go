// Command genexercisecatalog regenerates the trimmed, media-free exercise
// catalog served to the frontend from the pinned vendored source.
//
// Usage: go run ./cmd/genexercisecatalog [-src path] [-out path]
package main

import (
	"flag"
	"log/slog"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/exercisecatalog"
)

func main() {
	src := flag.String("src", "third_party/exercises-dataset/exercises.json", "vendored upstream source JSON")
	out := flag.String("out", "web/static/data/exercises-catalog.json", "output path for the trimmed catalog")
	flag.Parse()

	srcJSON, err := os.ReadFile(*src)
	if err != nil {
		slog.Error("read vendored source", "path", *src, "error", err)
		os.Exit(1)
	}
	trimmed, err := exercisecatalog.Trim(srcJSON)
	if err != nil {
		slog.Error("trim catalog", "error", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, trimmed, 0o644); err != nil {
		slog.Error("write catalog", "path", *out, "error", err)
		os.Exit(1)
	}
	slog.Info("wrote exercise catalog", "path", *out, "bytes", len(trimmed))
}
