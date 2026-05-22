//go:build mobile

// Package web provides a mobile-build-only embed of web/static so the
// Capacitor Android shell's WebView can load the PWA directly from the
// Go binary at http://127.0.0.1:<port>/. The server build does not import
// this package and continues to read web/static from disk.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var staticEmbed embed.FS

// StaticFS returns the embedded web/static directory rooted so that
// "index.html", "js/...", "css/...", etc. resolve directly under the FS
// root. cmd/bot/main_mobile.go passes the returned FS into the server via
// server.Server.SetStaticFS so the static-file handlers serve from the
// embedded copy rather than from a co-located "./web/static" directory
// (which does not exist when the binary runs from Android's read-only
// nativeLibraryDir).
func StaticFS() fs.FS {
	sub, err := fs.Sub(staticEmbed, "static")
	if err != nil {
		panic(err) // unreachable: //go:embed above pins "static/".
	}
	return sub
}
