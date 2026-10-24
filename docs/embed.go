// Package docs embeds the few docs/ files the cloud binary serves verbatim, so
// the markdown in this directory stays their single source of truth.
package docs

import _ "embed"

// PrivacyPolicy is privacy-policy.md, rendered at /privacy on the base host
// (internal/cloudserver/privacy.go, bd med-9u3s).
//
//go:embed privacy-policy.md
var PrivacyPolicy []byte
