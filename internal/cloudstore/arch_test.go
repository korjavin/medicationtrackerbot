package cloudstore

import (
	"os/exec"
	"strings"
	"testing"
)

// TestImportBoundary_CloudAndBotStayDecoupled is a durable guard (needed
// through C0b/C0c/C3a/C1, not just this plan): cloud mode must never grow
// server-side domain logic or trip the goose migration-registry landmine
// described in this package's doc comment, and a cloud-only change must
// never alter bot-mode behavior.
func TestImportBoundary_CloudAndBotStayDecoupled(t *testing.T) {
	t.Run("cmd/cloud stays decoupled from bot-mode packages", func(t *testing.T) {
		deps := goListDeps(t, "./cmd/cloud")
		for _, forbidden := range []string{
			"internal/store", // only internal/store/db is allowed
			"internal/domain",
			"internal/server",
			"internal/bot",
			"internal/scheduler",
		} {
			assertNoDep(t, deps, forbidden)
		}
	})

	t.Run("cmd/bot stays decoupled from cloud-mode packages", func(t *testing.T) {
		deps := goListDeps(t, "./cmd/bot")
		for _, forbidden := range []string{
			"internal/cloudstore",
			"internal/cloudserver",
		} {
			assertNoDep(t, deps, forbidden)
		}
	})
}

func goListDeps(t *testing.T, pkg string) []string {
	t.Helper()
	cmd := exec.Command("go", "list", "-deps", pkg)
	cmd.Dir = "../.." // repo root (this file lives in internal/cloudstore)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps %s: %v\n%s", pkg, err, out)
	}
	return strings.Fields(string(out))
}

func assertNoDep(t *testing.T, deps []string, suffix string) {
	t.Helper()
	full := "github.com/korjavin/medicationtrackerbot/" + suffix
	for _, dep := range deps {
		if dep == full {
			t.Errorf("dependency %s is forbidden here", full)
		}
	}
}
