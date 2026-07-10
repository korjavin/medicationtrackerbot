package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// An env var that cmd/cloud reads but docker-compose.cloud.yml never forwards
// is invisible: the binary silently falls back to its zero value and the
// feature it gates just doesn't work in the deployed stack. CLOUD_FOOD_DB_API_KEY
// shipped that way (med-eas.39 forwarded the key; compose never passed it), so
// pin the invariant rather than re-discover it in production.
func TestComposePassesEveryEnvCloudReads(t *testing.T) {
	root := filepath.Join("..", "..")

	compose, err := os.ReadFile(filepath.Join(root, "docker-compose.cloud.yml"))
	if err != nil {
		t.Fatalf("read compose: %v", err)
	}
	passed := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s+- ([A-Z_0-9]+)=`).FindAllStringSubmatch(string(compose), -1) {
		passed[m[1]] = true
	}

	getenv := regexp.MustCompile(`Getenv\("([A-Z_0-9]+)"\)`)
	var missing []string
	for _, dir := range []string{filepath.Join(root, "cmd", "cloud"), filepath.Join(root, "internal", "cloudserver")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read %s: %v", dir, err)
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			src, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatalf("read %s: %v", e.Name(), err)
			}
			for _, m := range getenv.FindAllStringSubmatch(string(src), -1) {
				if !passed[m[1]] {
					missing = append(missing, m[1]+" (read in "+e.Name()+")")
				}
			}
		}
	}

	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("cmd/cloud reads env vars that docker-compose.cloud.yml never forwards:\n  %s\n\n"+
			"Add each as `- NAME=${NAME:-}` under the cloud service's environment, "+
			"and document it in .env.cloud.example + docs/environment.md.",
			strings.Join(missing, "\n  "))
	}
}

// bd med-d5t.4 — "turn the storage quota ON by default". The bead was written
// believing quotaBytes stayed 0 when the env var was unset, which would leave
// every default deployment unprotected. It does not: loadConfig seeds 50MB and
// only a non-empty CLOUD_ACCOUNT_QUOTA_BYTES overrides it. That distinction is
// load-bearing and invisible — docker-compose.cloud.yml forwards the var as an
// empty string, so the safe default depends entirely on the `quota != ""` guard
// below not being "simplified" into an unconditional ParseInt.
//
// NewSyncAPI treats quotaBytes <= 0 as DISABLED, so a regression here silently
// removes the quota from every deployment rather than failing anything.
func TestLoadConfig_AccountQuotaDefaultsOn(t *testing.T) {
	t.Setenv("CLOUD_BASE_DOMAIN", "example.test")
	t.Setenv("SESSION_SECRET", "an-entirely-unpredictable-session-secret-value")

	const defaultQuota = 50 << 20

	t.Run("unset env keeps the 50MB default", func(t *testing.T) {
		t.Setenv("CLOUD_ACCOUNT_QUOTA_BYTES", "")
		os.Unsetenv("CLOUD_ACCOUNT_QUOTA_BYTES")

		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.accountQuotaBytes != defaultQuota {
			t.Errorf("accountQuotaBytes = %d, want %d (quota must be ON by default)", cfg.accountQuotaBytes, defaultQuota)
		}
	})

	// This is exactly what docker-compose's `${VAR:-}` produces.
	t.Run("empty env keeps the 50MB default, it does not disable the quota", func(t *testing.T) {
		t.Setenv("CLOUD_ACCOUNT_QUOTA_BYTES", "")

		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.accountQuotaBytes != defaultQuota {
			t.Errorf("accountQuotaBytes = %d, want %d (an empty env var must not disable the quota)", cfg.accountQuotaBytes, defaultQuota)
		}
	})

	t.Run("explicit 0 disables it, deliberately", func(t *testing.T) {
		t.Setenv("CLOUD_ACCOUNT_QUOTA_BYTES", "0")

		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.accountQuotaBytes != 0 {
			t.Errorf("accountQuotaBytes = %d, want 0", cfg.accountQuotaBytes)
		}
	})

	t.Run("an explicit value is honored", func(t *testing.T) {
		t.Setenv("CLOUD_ACCOUNT_QUOTA_BYTES", "12345")

		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.accountQuotaBytes != 12345 {
			t.Errorf("accountQuotaBytes = %d, want 12345", cfg.accountQuotaBytes)
		}
	})

	t.Run("a negative value is rejected rather than silently disabling the quota", func(t *testing.T) {
		t.Setenv("CLOUD_ACCOUNT_QUOTA_BYTES", "-1")

		if _, err := loadConfig(); err == nil {
			t.Error("loadConfig() error = nil, want an error for a negative quota")
		}
	})
}

// The compose file should not merely forward the var — it should carry the safe
// value, so `docker compose config` shows an operator what they are running.
func TestComposeCarriesAnExplicitQuotaDefault(t *testing.T) {
	compose, err := os.ReadFile(filepath.Join("..", "..", "docker-compose.cloud.yml"))
	if err != nil {
		t.Fatalf("read compose: %v", err)
	}
	if strings.Contains(string(compose), "CLOUD_ACCOUNT_QUOTA_BYTES=${CLOUD_ACCOUNT_QUOTA_BYTES:-}") {
		t.Error("docker-compose.cloud.yml forwards CLOUD_ACCOUNT_QUOTA_BYTES with an empty default; " +
			"give it an explicit value so the quota is visibly on")
	}
}
