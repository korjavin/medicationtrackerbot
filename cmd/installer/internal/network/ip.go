package network

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// DetectPublicIP tries to determine the server's public IP address, preferring IPv4.
// It first queries IPv4-only endpoints; if those all fail (e.g. on an IPv6-only
// host), it falls back to generic endpoints that may return an IPv6 address.
func DetectPublicIP(ctx context.Context) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}

	fetch := func(url string) string {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return ""
		}
		resp, err := client.Do(req)
		if err != nil {
			return ""
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
		_ = resp.Body.Close()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(body))
	}

	// Phase 1: try services that return only IPv4.
	// These will fail with a connection error on IPv6-only servers, which is fine.
	for _, svc := range []string{
		"https://api4.ipify.org",
		"https://ipv4.icanhazip.com",
	} {
		if ip := fetch(svc); ip != "" && !IsIPv6(ip) {
			return ip, nil
		}
	}

	// Phase 2: generic fallbacks — may return IPv6 on dual-stack or IPv6-only hosts.
	for _, svc := range []string{
		"https://ifconfig.me/ip",
		"https://api.ipify.org",
		"https://icanhazip.com",
	} {
		if ip := fetch(svc); ip != "" {
			return ip, nil
		}
	}

	return "", fmt.Errorf("could not detect public IP from any service")
}

// IsIPv6 reports whether ip is an IPv6 address (not a mapped IPv4 address).
func IsIPv6(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	return parsed.To4() == nil
}

// DNSRecordType returns "A" for IPv4 addresses and "AAAA" for IPv6.
func DNSRecordType(ip string) string {
	if IsIPv6(ip) {
		return "AAAA"
	}
	return "A"
}
