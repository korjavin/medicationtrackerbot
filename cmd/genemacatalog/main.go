// Command genemacatalog projects a separately downloaded, hash-verified workbook.
// It never downloads data and never emits the contacts-bearing source workbook.
package main

import (
	"encoding/json"
	"flag"
	"log/slog"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/emacatalog"
)

func main() {
	src := flag.String("src", "", "path to separately downloaded EMA Article 57 XLSX (required)")
	lock := flag.String("lock", "third_party/ema-article57/source.json", "reviewed source release lock")
	out := flag.String("out", "web/static/data/ema-article57-rev90-v1.json", "output catalogue")
	flag.Parse()
	if *src == "" {
		fail("provide -src; do not vendor the full workbook", nil)
	}
	lockBytes, err := os.ReadFile(*lock)
	if err != nil {
		fail("read release lock", err)
	}
	var source emacatalog.Source
	if err := json.Unmarshal(lockBytes, &source); err != nil {
		fail("decode release lock", err)
	}
	input, err := os.ReadFile(*src)
	if err != nil {
		fail("read source", err)
	}
	output, err := emacatalog.Generate(input, source)
	if err != nil {
		fail("project catalogue", err)
	}
	if err := os.WriteFile(*out, output, 0o644); err != nil {
		fail("write catalogue", err)
	}
	slog.Info("wrote EMA catalogue", "bytes", len(output))
}

func fail(message string, err error) { slog.Error(message, "error", err); os.Exit(1) }
