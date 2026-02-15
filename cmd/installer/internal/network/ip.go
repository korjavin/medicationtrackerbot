package network

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DetectPublicIP tries to determine the server's public IP address.
func DetectPublicIP(ctx context.Context) (string, error) {
	services := []string{
		"https://ifconfig.me/ip",
		"https://api.ipify.org",
		"https://icanhazip.com",
	}

	client := &http.Client{Timeout: 5 * time.Second}

	for _, svc := range services {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, svc, nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
		resp.Body.Close()
		if err != nil {
			continue
		}
		ip := strings.TrimSpace(string(body))
		if ip != "" {
			return ip, nil
		}
	}
	return "", fmt.Errorf("could not detect public IP from any service")
}
