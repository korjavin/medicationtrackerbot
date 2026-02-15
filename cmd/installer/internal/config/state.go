package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	stateFileName = ".installer_state.json"
	stateVersion  = 1
)

// StatePath returns the full path to the state file for the given install directory.
func StatePath(installDir string) string {
	return filepath.Join(installDir, stateFileName)
}

// NewInstallerState creates a fresh installer state.
func NewInstallerState() *InstallerState {
	return &InstallerState{
		Version:   stateVersion,
		StartedAt: time.Now(),
	}
}

// LoadState loads installer state from disk. Returns nil if the file doesn't exist.
func LoadState(installDir string) (*InstallerState, error) {
	path := StatePath(installDir)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state file: %w", err)
	}

	var state InstallerState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("parse state file: %w", err)
	}
	return &state, nil
}

// SaveState writes installer state to disk with restrictive permissions.
func SaveState(installDir string, state *InstallerState) error {
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		return fmt.Errorf("create install dir: %w", err)
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	path := StatePath(installDir)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write state file: %w", err)
	}
	return nil
}
