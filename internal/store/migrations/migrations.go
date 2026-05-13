// Package migrations holds the SQL migration files shipped with the store
// layer. It is a tiny Go package whose only export is FS — the embedded
// file system the goose runner reads — so per-domain test packages can
// re-use it without a cyclic import back into the legacy store package.
package migrations

import "embed"

// FS exposes the SQL migration files in this directory. It is consumed by
// (*db.DB).Migrate from both the legacy store package and per-domain test
// setups (e.g. internal/store/diary/diary_test.go).
//
//go:embed *.sql
var FS embed.FS
