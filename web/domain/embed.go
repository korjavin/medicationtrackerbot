// Package domainweb embeds the runtime-agnostic domain modules
// (web/domain) so cmd/cloud can serve them at /domain/ — the path
// web/cloud/js/apishim.js imports them from (../../domain/*.js resolves to
// /domain/*.js in the browser). Kept a separate embed rather than folded into
// web/cloud or web/static because web/domain is the goja-shared source layer
// mandated by CLAUDE.md (C6 runs it server-side); it must not be conflated
// with browser-only code.
package domainweb

import "embed"

//go:embed bp.js weight.js notes.js settings.js vitals.js medschedule.js medications.js
var FS embed.FS
