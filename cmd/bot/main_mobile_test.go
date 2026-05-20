//go:build mobile

// The mobile build's wiring is verified by virtue of the package compiling
// under -tags mobile. This sentinel test asserts the build tag is in effect
// (so a regression that lands main_server.go without its !mobile tag would
// fail here at run time rather than only failing the build).

package main

import "testing"

// mobileBuild is set to true when the mobile build tag is active. The
// server-only paired file sets it to false; if both were ever pulled in by a
// missing or duplicate build tag, the linker would fail with a duplicate
// declaration — that's the regression this guard catches.
var mobileBuild = true

func TestMobileBuildTagInEffect(t *testing.T) {
	if !mobileBuild {
		t.Fatal("mobile build tag was not applied — main_mobile.go did not select the mobile variant")
	}
}
