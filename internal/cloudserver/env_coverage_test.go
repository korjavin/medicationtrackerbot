package cloudserver_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestDockerCompose_CloudEnvironmentCoverage asserts that every environment variable
// read in internal/ and cmd/cloud/ is declared in docker-compose.cloud.yml under
// services.cloud.environment.
//
// In Docker Compose, stack environment variables (.env) are only forwarded into
// container processes if explicitly listed in the service's environment block.
// Omitting a variable (e.g. PRIVACY_NAME) leaves os.Getenv empty at runtime
// despite being present in Portainer or host env (bd med-ry1j).
func TestDockerCompose_CloudEnvironmentCoverage(t *testing.T) {
	root := filepath.Join("..", "..")
	fset := token.NewFileSet()

	// Parse compose environment strictly from services.cloud.environment.
	composeEnv := parseCloudServiceEnvironment(t, filepath.Join(root, "docker-compose.cloud.yml"))

	// Scan directories containing server code.
	scanDirs := []string{
		filepath.Join(root, "internal"),
		filepath.Join(root, "cmd", "cloud"),
	}

	type goFileInfo struct {
		path   string
		pkgDir string
		file   *ast.File
	}
	var parsedFiles []goFileInfo

	// Package-level string constants: map[pkgDir]map[constName]string
	pkgConsts := make(map[string]map[string]string)

	// Wrapper functions:
	// A wrapper is any function/method whose body passes one of its own parameters
	// to os.Getenv or os.LookupEnv.
	// We key package functions by "pkgDir:funcName" -> paramIndex
	pkgWrappers := make(map[string]int)
	// We key method wrappers by "recvType.methodName" or "methodName" -> paramIndex
	methodWrappers := make(map[string]int)

	// Tracks the exact CallExpr nodes inside wrappers that forward a parameter
	// so only that specific parameter read is skipped, not literal os.Getenv reads in the same body.
	wrapperForwardCalls := make(map[*ast.CallExpr]bool)

	// Step 1: Parse all Go files and extract package-level string constants and wrappers.
	for _, dir := range scanDirs {
		err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			f, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return err
			}
			pkgDir := filepath.Dir(path)
			parsedFiles = append(parsedFiles, goFileInfo{path: path, pkgDir: pkgDir, file: f})

			if pkgConsts[pkgDir] == nil {
				pkgConsts[pkgDir] = make(map[string]string)
			}

			// Collect package-level consts
			for _, decl := range f.Decls {
				gen, ok := decl.(*ast.GenDecl)
				if !ok || gen.Tok != token.CONST {
					continue
				}
				for _, spec := range gen.Specs {
					vspec, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, name := range vspec.Names {
						if i < len(vspec.Values) {
							if val, ok := evalStringExpr(vspec.Values[i], pkgConsts[pkgDir]); ok {
								pkgConsts[pkgDir][name.Name] = val
							}
						}
					}
				}
			}

			// Detect wrapper functions: functions passing a parameter to os.Getenv / os.LookupEnv
			for _, decl := range f.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Type.Params == nil || fn.Body == nil {
					continue
				}

				paramIndices := make(map[string]int)
				runningIdx := 0
				for _, param := range fn.Type.Params.List {
					for _, pName := range param.Names {
						paramIndices[pName.Name] = runningIdx
						runningIdx++
					}
				}
				if len(paramIndices) == 0 {
					continue
				}

				recvType := ""
				if fn.Recv != nil && len(fn.Recv.List) > 0 {
					switch t := fn.Recv.List[0].Type.(type) {
					case *ast.Ident:
						recvType = t.Name
					case *ast.StarExpr:
						if id, ok := t.X.(*ast.Ident); ok {
							recvType = id.Name
						}
					}
				}

				ast.Inspect(fn.Body, func(bodyNode ast.Node) bool {
					call, ok := bodyNode.(*ast.CallExpr)
					if !ok || len(call.Args) == 0 {
						return true
					}
					if isOsGetenvOrLookup(call) {
						if ident, ok := call.Args[0].(*ast.Ident); ok {
							if pIdx, ok := paramIndices[ident.Name]; ok {
								wrapperForwardCalls[call] = true
								if recvType != "" {
									methodWrappers[recvType+"."+fn.Name.Name] = pIdx
									methodWrappers[fn.Name.Name] = pIdx
								} else {
									pkgWrappers[pkgDir+":"+fn.Name.Name] = pIdx
									// Also record unqualified for intra-package calls
									pkgWrappers[fn.Name.Name] = pIdx
								}
							}
						}
					}
					return true
				})
			}

			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}

	// Step 2: Collect all env var reads across all files.
	// envVars maps envVarName -> list of "file:line" locations
	envVars := make(map[string][]string)

	for _, gfi := range parsedFiles {
		currentPkgConsts := pkgConsts[gfi.pkgDir]

		ast.Inspect(gfi.file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}

			// If this call is the parameter-forwarding site inside a wrapper function, skip it.
			if wrapperForwardCalls[call] {
				return true
			}

			var argExpr ast.Expr
			if isOsGetenvOrLookup(call) {
				if len(call.Args) > 0 {
					argExpr = call.Args[0]
				}
			} else if fnIdent, ok := call.Fun.(*ast.Ident); ok {
				// Bare function call: check package wrapper
				key := gfi.pkgDir + ":" + fnIdent.Name
				if pIdx, ok := pkgWrappers[key]; ok && len(call.Args) > pIdx {
					argExpr = call.Args[pIdx]
				} else if pIdx, ok := pkgWrappers[fnIdent.Name]; ok && len(call.Args) > pIdx {
					argExpr = call.Args[pIdx]
				}
			} else if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
				// Method call or package-qualified function call
				if pIdx, ok := methodWrappers[sel.Sel.Name]; ok && len(call.Args) > pIdx {
					argExpr = call.Args[pIdx]
				} else if pIdx, ok := pkgWrappers[sel.Sel.Name]; ok && len(call.Args) > pIdx {
					argExpr = call.Args[pIdx]
				}
			}

			if argExpr == nil {
				return true
			}

			posStr := fset.Position(call.Pos()).String()
			val, ok := evalStringExpr(argExpr, currentPkgConsts)
			if !ok {
				t.Errorf("%s: unresolvable dynamic environment variable argument in %s (must be string literal or constant)",
					posStr, gfi.path)
				return true
			}

			if val != "" {
				envVars[val] = append(envVars[val], posStr)
			}
			return true
		})
	}

	// Step 3: Assert all collected env vars exist in composeEnv.
	var missing []string
	for name := range envVars {
		if !composeEnv[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)

	for _, name := range missing {
		locs := strings.Join(envVars[name], ", ")
		t.Errorf("env var %q (read at %s) is missing from docker-compose.cloud.yml under services.cloud.environment",
			name, locs)
	}
}

func isOsGetenvOrLookup(call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	ident, ok := sel.X.(*ast.Ident)
	if !ok || ident.Name != "os" {
		return false
	}
	return sel.Sel.Name == "Getenv" || sel.Sel.Name == "LookupEnv"
}

// evalStringExpr evaluates string literals (raw or interpreted), string concatenations,
// or package constant identifiers.
func evalStringExpr(expr ast.Expr, consts map[string]string) (string, bool) {
	switch e := expr.(type) {
	case *ast.BasicLit:
		if e.Kind == token.STRING {
			s, err := strconv.Unquote(e.Value)
			return s, err == nil
		}
	case *ast.Ident:
		if consts != nil {
			if val, ok := consts[e.Name]; ok {
				return val, true
			}
		}
	case *ast.BinaryExpr:
		if e.Op == token.ADD {
			left, okL := evalStringExpr(e.X, consts)
			right, okR := evalStringExpr(e.Y, consts)
			if okL && okR {
				return left + right, true
			}
		}
	}
	return "", false
}

// parseCloudServiceEnvironment strictly parses services.cloud.environment from
// docker-compose.cloud.yml without picking up sibling services (litestream, telegram-bot-api)
// or global compose settings.
//
// Limitations: YAML anchors (<<: *x, environment: *envs), inline flow maps ({}),
// and quoted keys (- "NAME=x") are not supported. If used, the parser will fail loudly.
func parseCloudServiceEnvironment(t *testing.T, composePath string) map[string]bool {
	composeBytes, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read %s: %v", composePath, err)
	}

	lines := strings.Split(string(composeBytes), "\n")
	inServices := false
	inCloud := false
	inCloudEnv := false
	composeEnv := make(map[string]bool)

	listEnvRe := regexp.MustCompile(`^\s*-\s*([A-Za-z0-9_]+)(?:=.*)?$`)
	mapEnvRe := regexp.MustCompile(`^\s*([A-Za-z0-9_]+):`)

	for _, line := range lines {
		raw := strings.TrimRight(line, "\r")

		// End of services block (e.g. networks:, volumes:, x-logging:)
		if inServices && (strings.HasPrefix(raw, "networks:") || strings.HasPrefix(raw, "volumes:") || strings.HasPrefix(raw, "x-")) {
			inServices = false
			inCloud = false
			inCloudEnv = false
			continue
		}

		if strings.HasPrefix(raw, "services:") {
			inServices = true
			continue
		}

		if inServices {
			// Sibling services inside services: start at column 2 (e.g. "  litestream:", "  telegram-bot-api:")
			if raw == "  cloud:" {
				inCloud = true
				continue
			} else if len(raw) >= 3 && strings.HasPrefix(raw, "  ") && raw[2] != ' ' && raw[2] != '#' {
				// Encountered another service
				inCloud = false
				inCloudEnv = false
				continue
			}

			if inCloud {
				trimmed := strings.TrimSpace(raw)
				if trimmed == "" || strings.HasPrefix(trimmed, "#") {
					continue
				}

				if trimmed == "environment:" {
					inCloudEnv = true
					continue
				} else if inCloudEnv {
					// Inside cloud service, any directive at <= 4 spaces (e.g. "    command:", "    volumes:") ends environment
					if len(raw) >= 5 && strings.HasPrefix(raw, "    ") && raw[4] != ' ' && raw[4] != '-' {
						inCloudEnv = false
						continue
					}

					// Parse "- NAME" or "- NAME=value"
					if m := listEnvRe.FindStringSubmatch(raw); len(m) > 1 {
						composeEnv[m[1]] = true
						continue
					}
					// Parse "NAME: value"
					if m := mapEnvRe.FindStringSubmatch(raw); len(m) > 1 {
						composeEnv[m[1]] = true
						continue
					}
				}
			}
		}
	}

	if len(composeEnv) == 0 {
		t.Fatalf("failed to parse environment variables from %s under services.cloud.environment", composePath)
	}

	return composeEnv
}
