// Package webstatic embeds web/static for cmd/cloud so account subdomains
// can serve the real app frontend. This is separate from
// web/embed_mobile.go's embed (which is mobile-build-tagged and rooted one
// directory up) because cmd/cloud has no build-tag split and needs the FS
// unconditionally.
package webstatic

import "embed"

//go:embed index.html manifest.json css icons js vendor sw.js
var FS embed.FS
