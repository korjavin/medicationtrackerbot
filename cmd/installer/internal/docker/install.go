package docker

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// DistroInfo contains information about the Linux distribution.
type DistroInfo struct {
	ID   string
	Name string
}

// GetDistroInfo attempts to detect the Linux distribution.
func GetDistroInfo() (*DistroInfo, error) {
	return GetDistroInfoPath("/etc/os-release")
}

// GetDistroInfoPath attempts to detect the Linux distribution from the given path.
func GetDistroInfoPath(path string) (*DistroInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info := &DistroInfo{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "ID=") {
			info.ID = strings.Trim(strings.TrimPrefix(line, "ID="), "\"")
		} else if strings.HasPrefix(line, "NAME=") {
			info.Name = strings.Trim(strings.TrimPrefix(line, "NAME="), "\"")
		}
	}

	if info.ID == "" {
		return nil, fmt.Errorf("could not determine distribution ID")
	}

	return info, nil
}

// InstallCommand returns the recommended installation command for the given distro.
func (d *DistroInfo) InstallCommand() (string, string) {
	switch d.ID {
	case "ubuntu", "debian", "raspbian", "linuxmint":
		return "apt-get", "sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2"
	case "fedora", "centos", "rhel", "almalinux", "rocky":
		return "dnf", "sudo dnf install -y docker docker-compose-plugin"
	case "arch", "manjaro":
		return "pacman", "sudo pacman -S --noconfirm docker docker-compose"
	default:
		return "curl", "curl -fsSL https://get.docker.com | sh"
	}
}

// RunInstallCommand executes the installation command.
func RunInstallCommand(command string) error {
	// We split the command by && and run each part, or just run the whole thing in sh
	cmd := exec.Command("sh", "-c", command)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}
