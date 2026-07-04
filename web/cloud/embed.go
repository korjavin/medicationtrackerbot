// Package cloudweb embeds the cloud service's static shell (web/cloud) for
// cmd/cloud. Unlike web/embed_mobile.go this is unconditional — cmd/cloud has
// no build-tag split, and web/cloud is the single source (no on-disk fallback).
package cloudweb

import "embed"

//go:embed index.html signup.html css js vendor
var FS embed.FS
