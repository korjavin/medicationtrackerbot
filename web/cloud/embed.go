// Package cloudweb embeds the cloud service's static shell (web/cloud) for
// cmd/cloud. web/cloud is the single source (no on-disk fallback).
package cloudweb

import "embed"

//go:embed index.html signup.html sw.js css js vendor
var FS embed.FS
