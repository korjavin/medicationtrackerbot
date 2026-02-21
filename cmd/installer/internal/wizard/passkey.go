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

	// Use local port for API call — external HTTPS domain may not resolve from inside the server.
	// The user-facing link still uses the public HTTPS domain.
	client := pocketid.NewClient("http://127.0.0.1:1411", state.Secrets.PocketIDInstallerAPIKey)

	token, err := client.CreateOneTimeAccessToken(ctx, state.PocketID.UserID)
	if err != nil {
		return fmt.Errorf("generate passkey enrollment token: %w", err)
	}

	// Build the public-facing URL using the external domain.
	// Pocket-ID's short-link route /lc/<token> redirects to /login/alternative/code?code=<token>.
	enrollURL := fmt.Sprintf("https://%s/lc/%s",
		state.Config.PocketID.Domain, token.Token)

	fmt.Println()
	fmt.Print(ui.RenderPasskeyScreen(enrollURL))

	// Wait for user to press Enter
	fmt.Scanln()

	return nil
}
