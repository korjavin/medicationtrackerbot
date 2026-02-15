package docker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Compose runs a docker compose command in the given directory.
func (rt *Runtime) Compose(ctx context.Context, dir string, args ...string) (string, error) {
	cmdArgs := append(rt.ComposeCmd[1:], args...)
	cmd := exec.CommandContext(ctx, rt.ComposeCmd[0], cmdArgs...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "COMPOSE_PROJECT_NAME=medtracker")

	var stdout, stderr bytes.Buffer
	if rt.Stdout != nil {
		cmd.Stdout = io.MultiWriter(&stdout, rt.Stdout)
	} else {
		cmd.Stdout = &stdout
	}

	if rt.Stderr != nil {
		cmd.Stderr = io.MultiWriter(&stderr, rt.Stderr)
	} else {
		cmd.Stderr = &stderr
	}

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// ComposeUp starts services in the given directory.
func (rt *Runtime) ComposeUp(ctx context.Context, dir string, services ...string) error {
	args := []string{"up", "-d", "--remove-orphans"}
	args = append(args, services...)
	_, err := rt.Compose(ctx, dir, args...)
	return err
}

// ComposePull pulls images for services in the given directory.
func (rt *Runtime) ComposePull(ctx context.Context, dir string) error {
	_, err := rt.Compose(ctx, dir, "pull")
	return err
}

// ComposeDown stops and removes containers in the given directory.
func (rt *Runtime) ComposeDown(ctx context.Context, dir string) error {
	_, err := rt.Compose(ctx, dir, "down")
	return err
}

// ComposeLogs returns logs for a service.
func (rt *Runtime) ComposeLogs(ctx context.Context, dir string, service string, lines int) (string, error) {
	return rt.Compose(ctx, dir, "logs", "--tail", fmt.Sprintf("%d", lines), service)
}

// ComposeRestart restarts all services.
func (rt *Runtime) ComposeRestart(ctx context.Context, dir string) error {
	_, err := rt.Compose(ctx, dir, "restart")
	return err
}

// CreateNetwork creates a Docker network if it doesn't exist.
func (rt *Runtime) CreateNetwork(ctx context.Context, name string) error {
	// Check if network exists
	cmd := exec.CommandContext(ctx, rt.Command, "network", "inspect", name)
	if err := cmd.Run(); err == nil {
		return nil // already exists
	}

	cmd = exec.CommandContext(ctx, rt.Command, "network", "create", name)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("create network %s: %s", name, strings.TrimSpace(stderr.String()))
	}
	return nil
}
