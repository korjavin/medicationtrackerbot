//go:build !mobile

package main

// mobileBuild is the paired sentinel for the !mobile build. If both variants
// were ever pulled in (broken build tag), Go would refuse to compile with a
// duplicate declaration — which is exactly the regression we want to catch.
var mobileBuild = false
