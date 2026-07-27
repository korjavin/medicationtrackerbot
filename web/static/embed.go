// Package webstatic embeds web/static for cmd/cloud so account subdomains
// can serve the real app frontend. Separate from web/cloud/embed.go, which
// embeds the cloud shell rooted one directory up.
package webstatic

import "embed"

//go:embed index.html manifest.json css icons js vendor sw.js fonts data
var FS embed.FS
