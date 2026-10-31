package mcpshim

import (
	"bytes"
	"context"
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
	"time"
)

// A real kernel execution restriction catches the difference between valid
// bytes and a runnable installed process. Only this disposable Python child
// and its descendants receive the policy; the Go test/caller stay unchanged.
func TestInstallerBlockedExecution(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("child-only Landlock regression is Linux-specific")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Landlock fixture requires Python 3")
	}
	root := t.TempDir()
	tools := filepath.Join(root, "tools")
	_ = os.Mkdir(tools, 0700)
	self, _ := os.Executable()
	fixture, _ := os.ReadFile(self)
	for _, tool := range []string{"curl", "claude", "uname"} {
		if err := os.WriteFile(filepath.Join(tools, tool), fixture, 0700); err != nil {
			t.Fatal(err)
		}
	}
	payload := os.Getenv("MEDTRACKER_PACKAGED_SHIM_TEST_BINARY")
	if payload == "" {
		payload = filepath.Join(root, "genuine-packaged-helper")
		build := exec.Command("go", "build", "-trimpath", "-ldflags=-X main.version=0.1.0 -X main.commit="+strings.Repeat("a", 40), "-o", payload, "../../cmd/mcpshim")
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build genuine readiness fixture: %v %s", err, out)
		}
	}
	if err := os.Chmod(payload, 0700); err != nil {
		t.Fatal(err)
	}
	if err := exec.Command(payload, "--version").Run(); err != nil {
		t.Fatal("genuine helper cannot execute before the child-only policy")
	}
	contents, err := os.ReadFile(payload)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	asset := "mcpshim_0.1.0_linux_" + runtime.GOARCH
	data := filepath.Join(root, "data with spaces")
	binary := filepath.Join(data, "medtracker", "mcpshim", "0.1.0", "mcpshim")
	marker := filepath.Join(root, "registration-marker")
	installer, _ := filepath.Abs("../../scripts/install-mcpshim.sh")
	code := "mtmcp1.fixture-sensitive-value"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, python, "-c", landlockInstallerFixture, installer)
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "aarch64"
	}
	command.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "XDG_DATA_HOME="+data, "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_OS=Linux", "MCP_FIXTURE_ARCH="+arch, "MCP_FIXTURE_TOOLS="+tools, "MCP_FIXTURE_ASSET="+asset, "MCP_FIXTURE_CODE="+code, "MEDTRACKER_MCP_CODE="+code, "MCP_FIXTURE_MANIFEST="+hex.EncodeToString(digest[:])+"  "+asset+"\n", "MCP_FIXTURE_PAYLOAD="+payload, "MCP_FIXTURE_BINARY="+binary, "MCP_FIXTURE_REGISTRATION_MARKER="+marker)
	out, err := command.CombinedOutput()
	if status, ok := err.(*exec.ExitError); ok && status.ExitCode() == 77 {
		t.Skip("kernel cannot apply disposable child Landlock policy; no execution-policy proof claimed")
	}
	if err != nil {
		t.Fatal("child-only execution-policy fixture failed (output omitted)")
	}
	var result struct {
		InstallerExit int  `json:"installer_exit"`
		NativeDenied  bool `json:"native_denied"`
		SecretLeak    bool `json:"secret_leak"`
	}
	if json.Unmarshal(out, &result) != nil {
		t.Fatal("invalid execution-policy proof result")
	}
	if !result.NativeDenied || result.InstallerExit == 0 || result.SecretLeak {
		t.Fatal("blocked native execution must fail sanitized before registration")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("blocked native execution invoked Claude remove/add")
	}
	installed, _ := os.ReadFile(binary)
	if sha256.Sum256(installed) != digest {
		t.Fatal("execution refusal changed verified installed bytes")
	}
	t.Log("genuine packaged binary denied by child-only Linux policy; installer failed before explicit user removal/add, no key output")
}

const landlockInstallerFixture = `import ctypes,json,os,pathlib,subprocess,sys
class Ruleset(ctypes.Structure): _fields_=[('handled_access_fs',ctypes.c_uint64)]
class Beneath(ctypes.Structure):
 _pack_=1
 _fields_=[('allowed_access',ctypes.c_uint64),('parent_fd',ctypes.c_int32)]
try:
 libc=ctypes.CDLL(None,use_errno=True); rules=Ruleset(1)
 fd=libc.syscall(444,ctypes.byref(rules),ctypes.sizeof(rules),0)
 if fd<0: sys.exit(77)
 for path in ['/usr','/bin','/sbin','/lib','/lib64',os.environ['MCP_FIXTURE_TOOLS']]:
  if not pathlib.Path(path).exists(): continue
  opened=os.open(path,os.O_PATH|os.O_CLOEXEC); beneath=Beneath(1,opened)
  if libc.syscall(445,fd,1,ctypes.byref(beneath),0)<0: sys.exit(77)
  os.close(opened)
 if libc.prctl(38,1,0,0,0)<0 or libc.syscall(446,fd,0)<0: sys.exit(77)
 os.close(fd)
except (OSError,AttributeError): sys.exit(77)
code=os.environ['MCP_FIXTURE_CODE']
result=subprocess.run(['sh',sys.argv[1],'--version','0.1.0','--pairing-code',code,'--replace-user-health'],capture_output=True)
denied=False
try: subprocess.run([os.environ['MCP_FIXTURE_BINARY'],'--version'],capture_output=True)
except PermissionError: denied=True
print(json.dumps({'installer_exit':result.returncode,'native_denied':denied,'secret_leak':code.encode() in result.stdout+result.stderr}))
`

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
	hash := sha256.Sum256(fixture)
	env := append(os.Environ(), "CLAUDE_CONFIG_DIR="+config, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1", "XDG_DATA_HOME="+data, "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_OS=Linux", "MCP_FIXTURE_ARCH=x86_64", "MCP_FIXTURE_ASSET="+asset, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+hex.EncodeToString(hash[:])+"  "+asset+"\n")
	if runtime.GOOS == "darwin" {
		env = append(env, "MCP_FIXTURE_OS=Darwin")
	}
	env = append(env, "TMPDIR="+temporary)
	env = append(env, "MCP_FIXTURE_PAYLOAD="+self, "MEDTRACKER_MCP_CODE="+code)
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
	switch strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") {
	case "mcpshim":
		if len(os.Args) != 2 || os.Args[1] != "--version" {
			return 97
		}
		if _, present := os.LookupEnv("MEDTRACKER_MCP_CODE"); present {
			return 98
		}
		if os.Getenv("MCP_FIXTURE_PROBE_FAIL") == "1" {
			fmt.Fprintln(os.Stderr, os.Getenv("MCP_FIXTURE_CODE"))
			return 1
		}
		version := "0.1.0"
		if os.Getenv("MCP_FIXTURE_PROBE_VERSION") == "1" {
			version = "0.2.0"
		}
		fmt.Println("mcpshim " + version + "+" + strings.Repeat("a", 40))
		return 0
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
			data, _ = os.ReadFile(os.Getenv("MCP_FIXTURE_PAYLOAD"))
		} else {
			return 91
		}
		if os.WriteFile(output, data, 0600) != nil {
			return 92
		}
		return 0
	case "claude":
		args := os.Args[1:]
		if marker := os.Getenv("MCP_FIXTURE_REGISTRATION_MARKER"); marker != "" && len(args) > 1 {
			file, err := os.OpenFile(marker, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
			if err != nil {
				return 93
			}
			_, _ = file.WriteString(args[1] + "\n")
			_ = file.Close()
		}
		if strings.Join(args, " ") == "mcp remove --scope user health" {
			if os.Getenv("MCP_FIXTURE_REMOVE_FAIL") == "1" {
				fmt.Fprintln(os.Stderr, os.Getenv("MCP_FIXTURE_CODE"))
				return 1
			}
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
		{"noexec-existing", "Linux", "x86_64", "linux_amd64", "noexec", false, false},
		{"newline-version", "Linux", "x86_64", "linux_amd64", "newline", false, false},
		{"probe-failure", "Linux", "x86_64", "linux_amd64", "probe-fail", false, false},
		{"probe-version", "Linux", "x86_64", "linux_amd64", "probe-version", false, false},
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
			hash := sha256.Sum256(bytes)
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
			if test.manifest == "noexec" {
				_ = os.MkdirAll(filepath.Dir(binary), 0700)
				_ = os.WriteFile(binary, bytes, 0600)
			}
			marker := filepath.Join(root, "registration-marker")
			cmd := exec.Command("sh", "../../scripts/install-mcpshim.sh", "--version", "0.1.0", "--pairing-code", code)
			if test.manifest == "newline" {
				cmd.Args[3] = "0.1.0\ninvalid"
			}
			cmd.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "XDG_DATA_HOME="+data, "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_OS="+test.os, "MCP_FIXTURE_ARCH="+test.arch, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_ASSET="+asset, "MCP_FIXTURE_MANIFEST="+manifest, "MCP_FIXTURE_BINARY="+binary)
			if test.conflict {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_CONFLICT=1")
			}
			cmd.Env = append(cmd.Env, "MCP_FIXTURE_REGISTRATION_MARKER="+marker)
			cmd.Env = append(cmd.Env, "MCP_FIXTURE_PAYLOAD="+self, "MEDTRACKER_MCP_CODE="+code)
			if test.manifest == "probe-fail" || test.manifest == "probe-version" {
				cmd.Args = append(cmd.Args, "--replace-user-health")
				if test.manifest == "probe-fail" {
					cmd.Env = append(cmd.Env, "MCP_FIXTURE_PROBE_FAIL=1")
				} else {
					cmd.Env = append(cmd.Env, "MCP_FIXTURE_PROBE_VERSION=1")
				}
			}
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
				reusedOutput, reuseErr := reuse.CombinedOutput()
				if reuseErr != nil {
					t.Fatal("matching-byte reuse failed")
				}
				if strings.Contains(string(reusedOutput), code) {
					t.Fatal("reuse output exposed code")
				}
				if test.name == "linux-amd64" {
					for _, failure := range []string{"remove", "add"} {
						_ = os.Remove(marker)
						retry := exec.Command(cmd.Path, append(cmd.Args[1:], "--replace-user-health")...)
						retry.Env = append([]string{}, cmd.Env...)
						if failure == "remove" {
							retry.Env = append(retry.Env, "MCP_FIXTURE_REMOVE_FAIL=1")
						} else {
							retry.Env = append(retry.Env, "MCP_FIXTURE_CONFLICT=1")
						}
						out, err := retry.CombinedOutput()
						if err == nil {
							t.Fatal("explicit replacement failure reported success")
						}
						if strings.Contains(string(out), code) {
							t.Fatal("replacement failure exposed code")
						}
						calls, _ := os.ReadFile(marker)
						expected := "remove\n"
						if failure == "add" {
							expected += "add\n"
						}
						if string(calls) != expected {
							t.Fatal("replacement failure invoked an unexpected scope or command")
						}
						contents, _ := os.ReadFile(binary)
						if sha256.Sum256(contents) != hash {
							t.Fatal("replacement failure changed verified installed bytes")
						}
					}
				}
			}
			if !test.ok && !test.conflict && test.manifest != "existing" && test.manifest != "noexec" && test.manifest != "probe-fail" && test.manifest != "probe-version" {
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
	self, _ := os.Executable()
	payload, _ := os.ReadFile(self)
	for _, system := range []string{"darwin", "linux", "windows"} {
		for _, arch := range []string{"amd64", "arm64"} {
			name := "mcpshim_0.1.0_" + system + "_" + arch
			if system == "windows" {
				name += ".exe"
			}
			_ = os.WriteFile(filepath.Join(dist, name), payload, 0600)
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
	for _, tool := range []string{"curl", "claude", "uname"} {
		if runtime.GOOS == "windows" {
			tool += ".exe"
		}
		_ = os.WriteFile(filepath.Join(tools, tool), payload, 0700)
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
		command.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "MCP_INSTALL_FIXTURE_CHILD=1", "LOCALAPPDATA="+data, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+string(manifest), "MCP_FIXTURE_BINARY="+binary, "MCP_FIXTURE_INSTALLER="+filepath.Join(dist, "install.ps1"), "MCP_FIXTURE_ASSET=mcpshim_0.1.0_windows_"+arch+".exe")
	}
	command.Env = append(command.Env, "MCP_FIXTURE_PAYLOAD="+self, "MEDTRACKER_MCP_CODE="+code)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("exact native bootstrap failed: %v; sanitized diagnostics: %s", err, strings.ReplaceAll(string(out), code, "[REDACTED]"))
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
	for _, scenario := range []string{"success", "duplicate", "missing", "corrupt", "malformed", "newline", "conflict", "unknown", "replace", "remove-failure", "replace-add-failure", "probe-failure", "probe-version"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			fixture := filepath.Join(root, "fixture.ps1")
			tools := filepath.Join(root, "tools")
			_ = os.Mkdir(tools, 0700)
			self, _ := os.Executable()
			executable, _ := os.ReadFile(self)
			_ = os.WriteFile(filepath.Join(tools, "claude.exe"), executable, 0700)
			// Function overrides keep this a public-release transport fixture,
			// while executing the actual shipped installer on native PowerShell.
			driver := powerShellFixtureFunctions + "& $env:MCP_FIXTURE_INSTALLER -Version $env:MCP_FIXTURE_VERSION -PairingCode $env:MCP_FIXTURE_CODE -ReplaceUserHealth:($env:MCP_FIXTURE_REPLACE -eq '1'); exit $LASTEXITCODE\n"
			if err := os.WriteFile(fixture, []byte(driver), 0600); err != nil {
				t.Fatal(err)
			}
			suffix := "amd64"
			if runtime.GOARCH == "arm64" {
				suffix = "arm64"
			}
			asset := "mcpshim_0.1.0_windows_" + suffix + ".exe"
			hash := sha256.Sum256(executable)
			manifest := hex.EncodeToString(hash[:]) + "  " + asset + "\n"
			switch scenario {
			case "duplicate":
				manifest += manifest
			case "missing":
				manifest = ""
			case "corrupt":
				manifest = strings.Repeat("0", 64) + "  " + asset + "\n"
			case "malformed":
				manifest = "invalid  " + asset + "\n"
			}
			data := filepath.Join(root, "data with spaces")
			binary := filepath.Join(data, "MedTracker", "mcpshim", "0.1.0", "mcpshim.exe")
			if scenario == "unknown" {
				_ = os.MkdirAll(filepath.Dir(binary), 0700)
				_ = os.WriteFile(binary, []byte("old working bytes"), 0700)
			}
			code := "mtmcp1.fixture-sensitive-value"
			marker := filepath.Join(root, "registration-marker")
			cmd := exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-File", fixture)
			cmd.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"), "MCP_INSTALL_FIXTURE_CHILD=1", "MCP_FIXTURE_REGISTRATION_MARKER="+marker, "MCP_FIXTURE_VERSION=0.1.0", "LOCALAPPDATA="+data, "MCP_FIXTURE_INSTALLER="+script, "MCP_FIXTURE_CODE="+code, "MCP_FIXTURE_MANIFEST="+manifest, "MCP_FIXTURE_BINARY="+binary, "MCP_FIXTURE_ASSET="+asset)
			if scenario == "conflict" || scenario == "replace-add-failure" {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_CONFLICT=1")
			}
			if scenario == "replace" || scenario == "remove-failure" || scenario == "replace-add-failure" {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_REPLACE=1")
			}
			if scenario == "remove-failure" {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_REMOVE_FAIL=1")
			}
			if scenario == "newline" {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_VERSION=0.1.0\ninvalid")
			}
			cmd.Env = append(cmd.Env, "MCP_FIXTURE_PAYLOAD="+self, "MEDTRACKER_MCP_CODE="+code)
			if scenario == "probe-failure" || scenario == "probe-version" {
				cmd.Env = append(cmd.Env, "MCP_FIXTURE_REPLACE=1")
				if scenario == "probe-failure" {
					cmd.Env = append(cmd.Env, "MCP_FIXTURE_PROBE_FAIL=1")
				} else {
					cmd.Env = append(cmd.Env, "MCP_FIXTURE_PROBE_VERSION=1")
				}
			}
			out, err := cmd.CombinedOutput()
			if (err == nil) != (scenario == "success" || scenario == "replace") {
				t.Fatalf("unexpected native installer outcome: %v; sanitized diagnostics: %s", err, strings.ReplaceAll(string(out), code, "[REDACTED]"))
			}
			if strings.Contains(string(out), code) {
				t.Fatal("pairing code leaked")
			}
			if scenario == "success" {
				if _, err := os.Stat(binary); err != nil {
					t.Fatal("no installed binary")
				}
				reuse := exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-File", fixture)
				reuse.Env = cmd.Env
				out, err := reuse.CombinedOutput()
				if err != nil {
					t.Fatal("native matching-byte reuse failed")
				}
				if strings.Contains(string(out), code) {
					t.Fatal("native reuse exposed code")
				}
			}
			if scenario == "unknown" {
				bytes, _ := os.ReadFile(binary)
				if string(bytes) != "old working bytes" {
					t.Fatal("existing binary changed")
				}
			}
			switch scenario {
			case "duplicate", "missing", "corrupt", "malformed", "newline":
				if _, err := os.Stat(binary); !os.IsNotExist(err) {
					t.Fatal("native verification failure left a final executable")
				}
			}
			calls, _ := os.ReadFile(marker)
			expectedCalls := ""
			switch scenario {
			case "success":
				expectedCalls = "add\nadd\n"
			case "replace", "replace-add-failure":
				expectedCalls = "remove\nadd\n"
			case "remove-failure":
				expectedCalls = "remove\n"
			case "conflict":
				expectedCalls = "add\n"
			}
			if string(calls) != expectedCalls {
				t.Fatal("native verification/replacement invoked unexpected Claude operations")
			}
		})
	}
}

const powerShellFixtureFunctions = `function Invoke-WebRequest { param($Uri,$OutFile)
if ($Uri -notlike 'https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v0.1.0/*' -or $Uri.Contains($env:MCP_FIXTURE_CODE)) { throw 'URL boundary' }
if ($Uri.EndsWith('/SHA256SUMS')) { [IO.File]::WriteAllText($OutFile,$env:MCP_FIXTURE_MANIFEST) }
elseif ($Uri.EndsWith('/install.ps1')) { [IO.File]::Copy($env:MCP_FIXTURE_INSTALLER,$OutFile) }
elseif ($Uri.EndsWith('/'+$env:MCP_FIXTURE_ASSET)) { [IO.File]::Copy($env:MCP_FIXTURE_PAYLOAD,$OutFile) }
else { throw 'asset boundary' }
}
`
