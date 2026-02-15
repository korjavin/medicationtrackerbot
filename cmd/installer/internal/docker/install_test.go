package docker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetDistroInfo(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		wantID   string
		wantName string
	}{
		{
			name: "Ubuntu",
			content: `ID=ubuntu
NAME="Ubuntu"
`,
			wantID:   "ubuntu",
			wantName: "Ubuntu",
		},
		{
			name: "Debian",
			content: `ID=debian
NAME="Debian GNU/Linux"
`,
			wantID:   "debian",
			wantName: "Debian GNU/Linux",
		},
		{
			name: "Fedora",
			content: `ID=fedora
NAME="Fedora Linux"
`,
			wantID:   "fedora",
			wantName: "Fedora Linux",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			tmpFile := filepath.Join(tmpDir, "os-release")
			if err := os.WriteFile(tmpFile, []byte(tt.content), 0644); err != nil {
				t.Fatal(err)
			}

			info, err := GetDistroInfoPath(tmpFile)
			if err != nil {
				t.Fatalf("GetDistroInfoPath() error = %v", err)
			}

			if info.ID != tt.wantID {
				t.Errorf("ID = %v, want %v", info.ID, tt.wantID)
			}
			if info.Name != tt.wantName {
				t.Errorf("Name = %v, want %v", info.Name, tt.wantName)
			}
		})
	}
}

func TestInstallCommand(t *testing.T) {
	tests := []struct {
		id      string
		wantBin string
	}{
		{"ubuntu", "apt-get"},
		{"debian", "apt-get"},
		{"fedora", "dnf"},
		{"centos", "dnf"},
		{"arch", "pacman"},
		{"unknown", "curl"},
	}

	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			info := &DistroInfo{ID: tt.id}
			bin, _ := info.InstallCommand()
			if bin != tt.wantBin {
				t.Errorf("InstallCommand() bin = %v, want %v", bin, tt.wantBin)
			}
		})
	}
}
