package cloudserver_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// TestDockerCompose_CloudEnvironmentCoverage asserts that every environment variable
// read in internal/cloudserver and cmd/cloud is declared in docker-compose.cloud.yml
// under services.cloud.environment.
//
// In Docker Compose, stack environment variables (.env) are only forwarded into
// container processes if explicitly listed in the service's environment block.
// Omitting a variable (e.g. PRIVACY_NAME) leaves os.Getenv empty at runtime
// despite being present in Portainer or host env (bd med-ry1j).
func TestDockerCompose_CloudEnvironmentCoverage(t *testing.T) {
	root := filepath.Join("..", "..")
	fset := token.NewFileSet()
	envNames := make(map[string]string) // name -> location

	dirs := []string{
		filepath.Join(root, "internal", "cloudserver"),
		filepath.Join(root, "cmd", "cloud"),
	}

	for _, dir := range dirs {
		err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			f, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return err
			}
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) == 0 {
					return true
				}
				isEnvCall := false
				switch fun := call.Fun.(type) {
				case *ast.SelectorExpr:
					if ident, ok := fun.X.(*ast.Ident); ok && ident.Name == "os" && fun.Sel.Name == "Getenv" {
						isEnvCall = true
					}
				case *ast.Ident:
					if fun.Name == "envSeconds" || fun.Name == "privacyEnv" {
						isEnvCall = true
					}
				}
				if isEnvCall {
					if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
						name := strings.Trim(lit.Value, `"`)
						if name != "" {
							envNames[name] = path
						}
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}

	composePath := filepath.Join(root, "docker-compose.cloud.yml")
	composeBytes, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read %s: %v", composePath, err)
	}

	lines := strings.Split(string(composeBytes), "\n")
	inCloud := false
	inEnv := false
	composeEnv := make(map[string]bool)
	envRe := regexp.MustCompile(`^\s*-\s*([A-Z0-9_]+)=`)

	for _, line := range lines {
		if strings.HasPrefix(line, "  cloud:") {
			inCloud = true
			continue
		}
		if inCloud && len(line) > 2 && line[:2] != "  " {
			inCloud = false
			inEnv = false
		}
		if inCloud && strings.TrimSpace(line) == "environment:" {
			inEnv = true
			continue
		}
		if inEnv {
			if len(line) > 0 && !strings.HasPrefix(line, "    ") && !strings.HasPrefix(line, "      ") {
				inEnv = false
				continue
			}
			if m := envRe.FindStringSubmatch(line); len(m) > 1 {
				composeEnv[m[1]] = true
			}
		}
	}

	if len(composeEnv) == 0 {
		t.Fatalf("failed to parse environment variables from %s under services.cloud.environment", composePath)
	}

	var missing []string
	for name := range envNames {
		if !composeEnv[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)

	for _, name := range missing {
		t.Errorf("env var %q (used in %s) is missing from %s under services.cloud.environment",
			name, envNames[name], composePath)
	}
}
