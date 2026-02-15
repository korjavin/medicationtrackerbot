package docker

import (
	"fmt"
	"io"
	"os/exec"
	"strings"
)

// Runtime represents the detected container runtime.
type Runtime struct {
	Command        string   // "docker" or "podman"
	ComposeCmd     []string // e.g., ["docker", "compose"] or ["podman", "compose"]
	SocketPath     string
	Version        string
	ComposeVersion string
	Stdout         io.Writer
	Stderr         io.Writer
}

// Detect finds an available container runtime (Docker or Podman).
func Detect() (*Runtime, error) {
	// Try Docker first
	if path, err := exec.LookPath("docker"); err == nil {
		rt := &Runtime{Command: "docker", SocketPath: "/var/run/docker.sock"}

		// Get Docker version
		if out, err := exec.Command(path, "version", "--format", "{{.Server.Version}}").Output(); err == nil {
			rt.Version = strings.TrimSpace(string(out))
		}

		// Check for compose v2 plugin
		if out, err := exec.Command(path, "compose", "version", "--short").Output(); err == nil {
			rt.ComposeCmd = []string{"docker", "compose"}
			rt.ComposeVersion = strings.TrimSpace(string(out))
			return rt, nil
		}

		// Fallback: check for docker-compose standalone
		if _, err := exec.LookPath("docker-compose"); err == nil {
			if out, err := exec.Command("docker-compose", "version", "--short").Output(); err == nil {
				rt.ComposeCmd = []string{"docker-compose"}
				rt.ComposeVersion = strings.TrimSpace(string(out))
				return rt, nil
			}
		}

		return nil, fmt.Errorf("Docker found but docker compose plugin is not installed.\nInstall it: https://docs.docker.com/compose/install/")
	}

	// Try Podman
	if path, err := exec.LookPath("podman"); err == nil {
		rt := &Runtime{Command: "podman", SocketPath: "/run/podman/podman.sock"}

		if out, err := exec.Command(path, "version", "--format", "{{.Version}}").Output(); err == nil {
			rt.Version = strings.TrimSpace(string(out))
		}

		// Check for podman-compose
		if out, err := exec.Command("podman-compose", "version").Output(); err == nil {
			rt.ComposeCmd = []string{"podman-compose"}
			rt.ComposeVersion = strings.TrimSpace(string(out))
			return rt, nil
		}

		// Check for podman compose plugin
		if out, err := exec.Command(path, "compose", "version").Output(); err == nil {
			rt.ComposeCmd = []string{"podman", "compose"}
			rt.ComposeVersion = strings.TrimSpace(string(out))
			return rt, nil
		}

		return nil, fmt.Errorf("Podman found but compose is not available.\nInstall podman-compose: pip install podman-compose")
	}

	// Neither found, suggest installation
	msg := "Neither Docker nor Podman found."
	if distro, err := GetDistroInfo(); err == nil {
		_, cmd := distro.InstallCommand()
		msg = fmt.Sprintf("%s\nTo install Docker on %s, run:\n\n  %s", msg, distro.Name, cmd)
	} else {
		msg = fmt.Sprintf("%s\nInstall Docker: https://docs.docker.com/engine/install/", msg)
	}

	return nil, fmt.Errorf("%s", msg)
}
