package main

import (
	"fmt"
	"os"

	"github.com/korjavin/medicationtrackerbot/installer/internal/wizard"
)

func main() {
	if err := wizard.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "\nInstallation failed: %v\n", err)
		os.Exit(1)
	}
}
