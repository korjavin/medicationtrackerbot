package cloudserver

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
)

// proxyUpstream GETs upstreamURL (optionally with an X-API-Key header) and
// copies the upstream Content-Type + status + body to w. Shared by the blind
// food and RxNav proxies.
//
// SECURITY INVARIANT: upstreamURL embeds the user's query (drug name, rxcui
// list, food search term), and both http.NewRequestWithContext and
// http.Client.Do return *url.Error values whose Error() reproduces that URL
// verbatim — so log lines carry only the unwrapped cause, never err itself.
func proxyUpstream(client *http.Client, logPrefix, upstreamURL, apiKey string, w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		slog.Error(logPrefix+": failed to create request", "error", urlErrCause(err))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}

	resp, err := client.Do(req)
	if err != nil {
		slog.Error(logPrefix+": upstream request failed", "error", urlErrCause(err))
		http.Error(w, "gateway timeout", http.StatusGatewayTimeout)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// urlErrCause strips URL-bearing *url.Error wrappers, keeping the cause
// ("connection refused", "context deadline exceeded", ...).
func urlErrCause(err error) error {
	for {
		var ue *url.Error
		if !errors.As(err, &ue) || ue.Err == nil {
			return err
		}
		err = ue.Err
	}
}
