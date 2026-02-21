package wizard

import (
	"context"
	"fmt"
	"time"

	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
	"github.com/korjavin/medicationtrackerbot/installer/internal/docker"
	"github.com/korjavin/medicationtrackerbot/installer/internal/pocketid"
	"github.com/korjavin/medicationtrackerbot/installer/internal/ui"
)

func runPasskeyEnrollment(state *config.InstallerState, _ *docker.Runtime) error {
	if state.PocketID.UserID == "" {
		return fmt.Errorf("no Pocket-ID user created; cannot generate passkey enrollment link")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := pocketid.NewClient(
		"https://"+state.Config.PocketID.Domain,
		state.Secrets.PocketIDInstallerAPIKey,
	)

	token, err := client.CreateOneTimeAccessToken(ctx, state.PocketID.UserID)
	if err != nil {
		return fmt.Errorf("generate passkey enrollment token: %w", err)
	}

	enrollURL := fmt.Sprintf("https://%s/login/one-time-access-token/%s",
		state.Config.PocketID.Domain, token.Token)

	fmt.Println()
	fmt.Print(ui.RenderPasskeyScreen(enrollURL))

	// Wait for user to press Enter
	fmt.Scanln()

	return nil
}
