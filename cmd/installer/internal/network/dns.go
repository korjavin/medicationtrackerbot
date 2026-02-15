package network

import (
	"context"
	"net"
	"time"
)

// DNSResult represents the result of a DNS resolution check.
type DNSResult struct {
	Domain   string
	Resolved bool
	IPs      []string
	Error    error
}

// CheckDNS resolves a domain and returns the result.
func CheckDNS(ctx context.Context, domain string) DNSResult {
	resolver := &net.Resolver{
		PreferGo: true,
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	addrs, err := resolver.LookupHost(ctx, domain)
	if err != nil {
		return DNSResult{Domain: domain, Resolved: false, Error: err}
	}
	return DNSResult{Domain: domain, Resolved: true, IPs: addrs}
}

// PollDNS checks DNS resolution for a list of domains, calling the callback
// with results. Returns when all domains resolve or the context is cancelled.
func PollDNS(ctx context.Context, domains []string, interval time.Duration, callback func(DNSResult)) error {
	pending := make(map[string]bool)
	for _, d := range domains {
		pending[d] = true
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		for domain := range pending {
			result := CheckDNS(ctx, domain)
			callback(result)
			if result.Resolved {
				delete(pending, domain)
			}
		}

		if len(pending) == 0 {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
