package mcpshim

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstallerInstalledClaudeIsolated(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native PowerShell fixture is the Windows CI boundary")
	}
	claude, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("installed Claude Code parser proof is local; no CLI credential needed")
	}
	root := t.TempDir()
	var sandbox []string
	if os.Getenv("MCP_CLAUDE_EPHEMERAL_RUNNER") != "1" {
		bwrap, err := exec.LookPath("bwrap")
		if err != nil {
			t.Skip("installed Claude mutation proof requires clean ephemeral runner or read-only home sandbox")
		}
		sandbox = []string{bwrap, "--ro-bind", "/", "/", "--bind", root, root, "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--"}
		probe := exec.Command(sandbox[0], append(sandbox[1:], "true")...)
		if err := probe.Run(); err != nil {
			t.Skip("read-only home sandbox unavailable; use clean ephemeral native CI runner")
		}
	}
	config := filepath.Join(root, "isolated claude config")
	cwd := filepath.Join(root, "unrelated workspace")
	tools := filepath.Join(root, "tools")
	temporary := filepath.Join(root, "tmp")
	for _, dir := range []string{config, cwd, tools, temporary} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	self, _ := os.Executable()
	fixture, _ := os.ReadFile(self)
	for _, tool := range []string{"curl", "uname"} {
		if err := os.WriteFile(filepath.Join(tools, tool), fixture, 0700); err != nil {
			t.Fatal(err)
		}
	}
	installer, _ := filepath.Abs("../../scripts/install-mcpshim.sh")
	code := "mtmcp1.fixture-sensitive-value"
	data := filepath.Join(root, "data with spaces")
	asset := "mcpshim_0.1.0_linux_amd64"
	if runtime.GOOS == "darwin" {
		asset = "mcpshim_0.1.0_darwin_amd64"
	}
	hash := sha256.Sum256([]byte("fixture executable bytes"))
	env := append(os.Environ(), "CLAUDE_CONFIG_DIR="+config, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1", "XDG_DATA_HOME="+data, "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_OS=Linux", "MCP_FIXTURE_ARCH=x86_64", "MCP_FIXTURE_ASSET="+asset, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+hex.EncodeToString(hash[:])+"  "+asset+"\n")
	if runtime.GOOS == "darwin" {
		env = append(env, "MCP_FIXTURE_OS=Darwin")
	}
	env = append(env, "TMPDIR="+temporary)
	run := func(program string, args ...string) ([]byte, error) {
		arguments := append([]string{}, sandbox...)
		arguments = append(arguments, program)
		arguments = append(arguments, args...)
		cmd := exec.Command(arguments[0], arguments[1:]...)
		cmd.Env = env
		cmd.Dir = cwd
		return cmd.CombinedOutput()
	}
	// Only Claude's supported isolated user config stores the fixture code,
	// exactly as in real registration. It is never dumped or copied by tests.
	if _, err := run(claude, "mcp", "add", "--transport", "stdio", "--scope", "user", "unrelated", "--", "/unrelated"); err != nil {
		t.Fatal("isolated Claude fixture setup failed")
	}
	args := []string{installer, "--version", "0.1.0", "--pairing-code", code}
	for i, replace := range []bool{false, false, true} {
		invocation := append([]string{}, args...)
		if replace {
			invocation = append(invocation, "--replace-user-health")
		}
		out, err := run("sh", invocation...)
		if bytes.Contains(out, []byte(code)) {
			t.Fatal("real CLI output exposed fixture code")
		}
		if (err == nil) != (i != 1) {
			t.Fatalf("real isolated Claude registration/conflict/retry step %d failed (output omitted)", i)
		}
	}
	out, err := run(claude, "mcp", "get", "unrelated")
	if err != nil || !bytes.Contains(out, []byte("/unrelated")) {
		t.Fatal("unrelated isolated entry changed")
	}
	// Inspect only files under the newly-created fixture config boundary.
	found := false
	_ = filepath.WalkDir(config, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			contents, _ := os.ReadFile(path)
			if bytes.Contains(contents, []byte(code)) {
				found = true
			}
		}
		return nil
	})
	if !found {
		t.Fatal("installed Claude did not store fixture within its documented isolated config boundary")
	}
	t.Log("installed Claude CLI: isolated add, duplicate conflict, explicit user replacement, and unrelated-entry preservation passed; HOME unchanged")
}

// A copied test executable acts as the download and Claude command boundary.
// All pairing-code/argv assertions happen in memory, never in trace files.
func TestMain(m *testing.M) {
	if os.Getenv("MCP_INSTALL_FIXTURE_CHILD") == "1" {
		os.Exit(installerFixtureCommand())
	}
	os.Exit(m.Run())
}

func installerFixtureCommand() int {
	switch filepath.Base(os.Args[0]) {
	case "uname":
		if os.Args[1] == "-s" {
			fmt.Println(os.Getenv("MCP_FIXTURE_OS"))
		} else {
			fmt.Println(os.Getenv("MCP_FIXTURE_ARCH"))
		}
		return 0
	case "curl":
		args := os.Args[1:]
		output := ""
		for i, arg := range args {
			if (arg == "--output" || arg == "-o") && i+1 < len(args) {
				output = args[i+1]
			}
		}
		url := ""
		for _, arg := range args {
			if strings.HasPrefix(arg, "https://") {
				url = arg
			}
		}
		prefix := "https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v0.1.0/"
		if !strings.HasPrefix(url, prefix) || strings.Contains(url, os.Getenv("MCP_FIXTURE_CODE")) {
			return 90
		}
		name := strings.TrimPrefix(url, prefix)
		var data []byte
		if name == "SHA256SUMS" {
			data = []byte(os.Getenv("MCP_FIXTURE_MANIFEST"))
		} else if name == "install.sh" {
			data, _ = os.ReadFile(os.Getenv("MCP_FIXTURE_INSTALLER"))
		} else if name == os.Getenv("MCP_FIXTURE_ASSET") {
			data = []byte("fixture executable bytes")
		} else {
			return 91
		}
		if os.WriteFile(output, data, 0600) != nil {
			return 92
		}
		return 0
	case "claude":
		if marker := os.Getenv("MCP_FIXTURE_REGISTRATION_MARKER"); marker != "" {
			_ = os.WriteFile(marker, []byte("called"), 0600)
		}
		args := os.Args[1:]
		if strings.Join(args, " ") == "mcp remove --scope user health" {
			return 0
		}
		expected := []string{"mcp", "add", "--env", "MEDTRACKER_MCP_CODE=" + os.Getenv("MCP_FIXTURE_CODE"), "--transport", "stdio", "--scope", "user", "health", "--", os.Getenv("MCP_FIXTURE_BINARY")}
		if len(args) != len(expected) {
			return 94
		}
		for i := range args {
			if args[i] != expected[i] {
				return 95
			}
		}
		if os.Getenv("MCP_FIXTURE_CONFLICT") == "1" {
			fmt.Fprintln(os.Stderr, os.Getenv("MCP_FIXTURE_CODE"))
			return 1
		}
		return 0
	}
	return 96
}

func TestInstallers(t *testing.T) {
	if runtime.GOOS == "windows" {
		testPowerShellInstaller(t)
		return
	}
	for _, test := range []struct {
		name, os, arch, suffix, manifest string
		ok, conflict                     bool
	}{
		{"linux-amd64", "Linux", "x86_64", "linux_amd64", "valid", true, false},
		{"linux-arm64", "Linux", "aarch64", "linux_arm64", "valid", true, false},
		{"darwin-amd64", "Darwin", "x86_64", "darwin_amd64", "valid", true, false},
		{"darwin-arm64", "Darwin", "arm64", "darwin_arm64", "valid", true, false},
		{"duplicate", "Linux", "x86_64", "linux_amd64", "duplicate", false, false},
		{"missing", "Linux", "x86_64", "linux_amd64", "missing", false, false},
		{"corrupt", "Linux", "x86_64", "linux_amd64", "corrupt", false, false},
		{"malformed", "Linux", "x86_64", "linux_amd64", "malformed", false, false},
		{"unsupported", "Linux", "riscv64", "linux_amd64", "valid", false, false},
		{"conflict", "Linux", "x86_64", "linux_amd64", "valid", false, true},
		{"unknown-existing", "Linux", "x86_64", "linux_amd64", "existing", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			tools := filepath.Join(root, "tools")
			_ = os.Mkdir(tools, 0700)
			self, _ := os.Executable()
			bytes, _ := os.ReadFile(self)
			for _, command := range []string{"curl", "claude", "uname"} {
				if err := os.WriteFile(filepath.Join(tools, command), bytes, 0700); err != nil {
					t.Fatal(err)
				}
			}
			asset := "mcpshim_0.1.0_" + test.suffix
			hash := sha256.Sum256([]byte("fixture executable bytes"))
			manifest := hex.EncodeToString(hash[:]) + "  " + asset + "\n"
			switch test.manifest {
			case "duplicate":
				manifest += manifest
			case "missing":
				manifest = ""
			case "corrupt":
				manifest = strings.Repeat("0", 64) + "  " + asset + "\n"
			case "malformed":
				manifest = "bad  " + asset + "\n"
			}
			code := "mtmcp1.fixture-sensitive-value"
			data := filepath.Join(root, "data with spaces")
			binary := filepath.Join(data, "medtracker", "mcpshim", "0.1.0", "mcpshim")
			if test.manifest == "existing" {
				_ = os.MkdirAll(filepath.Dir(binary), 0700)
				_ = os.WriteFile(binary, []byte("old working bytes"), 0700)
			}
			marker := filepath.Join(root, "registration-marker")
			cmd := exec.Command("sh", "../../scripts/install-mcpshim.sh", "--version", "0.1.0", "--pairing-code", code)
			cmd.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "XDG_DATA_HOME="+data, "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_OS="+test.os, "MCP_FIXTURE_ARCH="+test.arch, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_ASSET="+asset, "MCP_FIXTURE_MANIFEST="+manifest, "MCP_FIXTURE_BINARY="+binary)
			if test.conflict {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_CONFLICT=1")
			}
			cmd.Env = append(cmd.Env, "MCP_FIXTURE_REGISTRATION_MARKER="+marker)
			out, err := cmd.CombinedOutput()
			if (err == nil) != test.ok {
				t.Fatalf("unexpected installer outcome: %v (sanitized output omitted)", err)
			}
			if strings.Contains(string(out), code) {
				t.Fatal("pairing code leaked")
			}
			if test.ok {
				before, _ := os.Stat(binary)
				if before == nil {
					t.Fatal("no installed binary")
				}
				reuse := exec.Command(cmd.Path, cmd.Args[1:]...)
				reuse.Env = cmd.Env
				if out, err = reuse.CombinedOutput(); err != nil {
					t.Fatal("matching-byte reuse failed")
				}
			}
			if !test.ok && !test.conflict && test.manifest != "existing" {
				if _, err := os.Stat(binary); err == nil {
					t.Fatal("verification failure installed executable")
				}
			}
			if !test.ok && !test.conflict {
				if _, err := os.Stat(marker); err == nil {
					t.Fatal("verification failure invoked Claude")
				}
			}
			if test.manifest == "existing" {
				bytes, _ := os.ReadFile(binary)
				if string(bytes) != "old working bytes" {
					t.Fatal("old working version changed")
				}
			}
		})
	}
}

func TestPackagedInstallCommands(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		python, err = exec.LookPath("python")
	}
	if err != nil {
		t.Fatal("release contract test requires Python 3")
	}
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	tools := filepath.Join(root, "tools")
	for _, dir := range []string{dist, tools} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, system := range []string{"darwin", "linux", "windows"} {
		for _, arch := range []string{"amd64", "arm64"} {
			name := "mcpshim_0.1.0_" + system + "_" + arch
			if system == "windows" {
				name += ".exe"
			}
			_ = os.WriteFile(filepath.Join(dist, name), []byte("fixture executable bytes"), 0600)
		}
	}
	packageCmd := exec.Command(python, "../../scripts/package-mcpshim.py", dist, "--version", "0.1.0", "--commit", strings.Repeat("a", 40), "--run-url", "https://github.com/korjavin/medicationtrackerbot/actions/runs/fixture")
	if out, err := packageCmd.CombinedOutput(); err != nil {
		t.Fatalf("package contract: %v %s", err, out)
	}
	var contract struct {
		POSIX      string            `json:"posix"`
		PowerShell string            `json:"powershell"`
		Digests    map[string]string `json:"installer_sha256"`
	}
	encoded, _ := os.ReadFile(filepath.Join(dist, "commands.json"))
	if err := json.Unmarshal(encoded, &contract); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"install.sh", "install.ps1"} {
		bytes, _ := os.ReadFile(filepath.Join(dist, name))
		digest := sha256.Sum256(bytes)
		if contract.Digests[name] != hex.EncodeToString(digest[:]) {
			t.Fatal("bootstrap installer digest differs from exact bytes")
		}
	}
	if !strings.Contains(contract.PowerShell, contract.Digests["install.ps1"]) {
		t.Fatal("PowerShell bootstrap omits installer digest")
	}
	self, _ := os.Executable()
	bytes, _ := os.ReadFile(self)
	for _, tool := range []string{"curl", "claude", "uname"} {
		_ = os.WriteFile(filepath.Join(tools, tool), bytes, 0700)
	}
	code := "mtmcp1.fixture-sensitive-value"
	data := filepath.Join(root, "data with spaces")
	binary := filepath.Join(data, "medtracker", "mcpshim", "0.1.0", "mcpshim")
	manifest, _ := os.ReadFile(filepath.Join(dist, "SHA256SUMS"))
	installer := filepath.Join(dist, "install.sh")
	command := exec.Command("sh", "-c", strings.ReplaceAll(contract.POSIX, "<PAIRING_CODE>", code))
	command.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "XDG_DATA_HOME="+data, "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_OS=Linux", "MCP_FIXTURE_ARCH=x86_64", "MCP_FIXTURE_ASSET=mcpshim_0.1.0_linux_amd64", "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+string(manifest), "MCP_FIXTURE_BINARY="+binary, "MCP_FIXTURE_INSTALLER="+installer)
	if runtime.GOOS == "windows" {
		arch := "amd64"
		if runtime.GOARCH == "arm64" {
			arch = "arm64"
		}
		binary = filepath.Join(data, "MedTracker", "mcpshim", "0.1.0", "mcpshim.exe")
		command = exec.Command("pwsh", "-NoProfile", "-NonInteractive", "-Command", powerShellFixtureFunctions+strings.ReplaceAll(contract.PowerShell, "<PAIRING_CODE>", code))
		command.Env = append(os.Environ(), "LOCALAPPDATA="+data, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+string(manifest), "MCP_FIXTURE_BINARY="+binary, "MCP_FIXTURE_INSTALLER="+filepath.Join(dist, "install.ps1"), "MCP_FIXTURE_ASSET=mcpshim_0.1.0_windows_"+arch+".exe")
	}
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("exact POSIX bootstrap failed: %v (output omitted)", err)
	}
	if strings.Contains(string(out), code) {
		t.Fatal("bootstrap exposed pairing code")
	}
}

func testPowerShellInstaller(t *testing.T) {
	// Native Windows only; do not claim Bash simulation as Windows evidence.
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Fatal("native installer smoke requires PowerShell")
	}
	script, _ := filepath.Abs("../../scripts/install-mcpshim.ps1")
	for _, scenario := range []string{"success", "duplicate", "missing", "corrupt", "conflict", "unknown"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			fixture := filepath.Join(root, "fixture.ps1")
			// Function overrides keep this a public-release transport fixture,
			// while executing the actual shipped installer on native PowerShell.
			driver := powerShellFixtureFunctions + "& $env:MCP_FIXTURE_INSTALLER -Version 0.1.0 -PairingCode $env:MCP_FIXTURE_CODE\n"
			if err := os.WriteFile(fixture, []byte(driver), 0600); err != nil {
				t.Fatal(err)
			}
			suffix := "amd64"
			if runtime.GOARCH == "arm64" {
				suffix = "arm64"
			}
			asset := "mcpshim_0.1.0_windows_" + suffix + ".exe"
			hash := sha256.Sum256([]byte("fixture executable bytes"))
			manifest := hex.EncodeToString(hash[:]) + "  " + asset + "\n"
			switch scenario {
			case "duplicate":
				manifest += manifest
			case "missing":
				manifest = ""
			case "corrupt":
				manifest = strings.Repeat("0", 64) + "  " + asset + "\n"
			}
			data := filepath.Join(root, "data with spaces")
			binary := filepath.Join(data, "MedTracker", "mcpshim", "0.1.0", "mcpshim.exe")
			if scenario == "unknown" {
				_ = os.MkdirAll(filepath.Dir(binary), 0700)
				_ = os.WriteFile(binary, []byte("old working bytes"), 0700)
			}
			code := "mtmcp1.fixture-sensitive-value"
			cmd := exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-File", fixture)
			cmd.Env = append(os.Environ(), "LOCALAPPDATA="+data, "MCP_FIXTURE_INSTALLER="+script, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+manifest, "MCP_FIXTURE_BINARY="+binary, "MCP_FIXTURE_ASSET="+asset)
			if scenario == "conflict" {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_CONFLICT=1")
			}
			out, err := cmd.CombinedOutput()
			if (err == nil) != (scenario == "success") {
				t.Fatalf("unexpected native installer outcome: %v (sanitized output omitted)", err)
			}
			if strings.Contains(string(out), code) {
				t.Fatal("pairing code leaked")
			}
			if scenario == "success" {
				if _, err := os.Stat(binary); err != nil {
					t.Fatal("no installed binary")
				}
			}
			if scenario == "unknown" {
				bytes, _ := os.ReadFile(binary)
				if string(bytes) != "old working bytes" {
					t.Fatal("existing binary changed")
				}
			}
		})
	}
}

const powerShellFixtureFunctions = `function Invoke-WebRequest { param($Uri,$OutFile)
if ($Uri -notlike 'https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v0.1.0/*' -or $Uri.Contains($env:MCP_FIXTURE_CODE)) { throw 'URL boundary' }
if ($Uri.EndsWith('/SHA256SUMS')) { [IO.File]::WriteAllText($OutFile,$env:MCP_FIXTURE_MANIFEST) }
elseif ($Uri.EndsWith('/install.ps1')) { [IO.File]::Copy($env:MCP_FIXTURE_INSTALLER,$OutFile) }
elseif ($Uri.EndsWith('/'+$env:MCP_FIXTURE_ASSET)) { [IO.File]::WriteAllText($OutFile,'fixture executable bytes') }
else { throw 'asset boundary' }
}
function claude { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Arguments)
$expected = @('mcp','add','--env',('MEDTRACKER_MCP_CODE='+$env:MCP_FIXTURE_CODE),'--transport','stdio','--scope','user','health','--',$env:MCP_FIXTURE_BINARY)
if ($Arguments.Count -ne $expected.Count) { throw 'argv count' }
for ($i=0; $i -lt $expected.Count; $i++) { if ($Arguments[$i] -cne $expected[$i]) { throw 'argv boundary' } }
$global:LASTEXITCODE = 0
if ($env:MCP_FIXTURE_CONFLICT -eq '1') { Write-Output $env:MCP_FIXTURE_CODE; $global:LASTEXITCODE = 1 }
}
`
