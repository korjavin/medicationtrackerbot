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
	file, err := os.Open(path) // #nosec G304 -- path is /etc/os-release, a known fixed system file
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

// RunInstallCommand executes the installation command safely without using a shell.
func RunInstallCommand(command string) error {
	switch command {
	case "sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2":
		cmd1 := exec.Command("sudo", "apt-get", "update")
		cmd1.Stdout, cmd1.Stderr, cmd1.Stdin = os.Stdout, os.Stderr, os.Stdin
		if err := cmd1.Run(); err != nil {
			return fmt.Errorf("apt-get update failed: %w", err)
		}

		cmd2 := exec.Command("sudo", "apt-get", "install", "-y", "docker.io", "docker-compose-v2")
		cmd2.Stdout, cmd2.Stderr, cmd2.Stdin = os.Stdout, os.Stderr, os.Stdin
		return cmd2.Run()

	case "sudo dnf install -y docker docker-compose-plugin":
		cmd := exec.Command("sudo", "dnf", "install", "-y", "docker", "docker-compose-plugin")
		cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
		return cmd.Run()

	case "sudo pacman -S --noconfirm docker docker-compose":
		cmd := exec.Command("sudo", "pacman", "-S", "--noconfirm", "docker", "docker-compose")
		cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
		return cmd.Run()

	case "curl -fsSL https://get.docker.com | sh":
		cmd1 := exec.Command("curl", "-fsSL", "https://get.docker.com")
		cmd2 := exec.Command("sh")

		pipe, err := cmd1.StdoutPipe()
		if err != nil {
			return err
		}
		cmd2.Stdin = pipe
		cmd2.Stdout = os.Stdout
		cmd2.Stderr = os.Stderr

		if err := cmd1.Start(); err != nil {
			return err
		}
		if err := cmd2.Start(); err != nil {
			return err
		}

		if err := cmd2.Wait(); err != nil {
			return fmt.Errorf("sh failed: %w", err)
		}
		if err := cmd1.Wait(); err != nil {
			return fmt.Errorf("curl failed: %w", err)
		}
		return nil

	default:
		return fmt.Errorf("security error: untrusted or unknown installation command rejected")
	}
}
