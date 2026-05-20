//go:build !mobile

package main

import "testing"

// mobileBuild is the paired sentinel for the !mobile build. If both variants
// were ever pulled in (broken build tag), Go would refuse to compile with a
// duplicate declaration — which is exactly the regression we want to catch.
var mobileBuild = false

func TestServerBuildTagInEffect(t *testing.T) {
	if mobileBuild {
		t.Fatal("server build tag was not applied — main_mobile.go selected the mobile variant in a !mobile build")
	}
}
