package cloudserver

import "testing"

func TestStampDevVersion(t *testing.T) {
	dev := []byte(`<script src="a.js?v=TIMESTAMP_PLACEHOLDER"></script><span>VERSION_PLACEHOLDER</span>`)
	out, id := stampDevVersion(dev, devBuildID, "abc1234-dirty")
	if string(out) != `<script src="a.js?v=TIMESTAMP_PLACEHOLDER"></script><span>abc1234-dirty</span>` || id != "abc1234-dirty" {
		t.Fatalf("dev stamp: %s %s", out, id)
	}
	if out, id = stampDevVersion(dev, devBuildID, ""); id != "dev" || string(out) == string(dev) {
		t.Fatalf("no vcs should fall back to dev: %s %s", out, id)
	}
	prod := []byte(`<script src="a.js?v=1700"></script><span>v1.2.3</span>`)
	if out, id = stampDevVersion(prod, "1700", "abc"); string(out) != string(prod) || id != "1700" {
		t.Fatalf("production output must be unchanged: %s %s", out, id)
	}
}
