// Command tlsfront is the Android QA harness's TLS terminator (bd med-nt9p.24):
// a throwaway self-signed CA plus a leaf for *.<domain>, <domain> and any extra
// hosts, serving HTTPS on -listen and proxying to the plain-HTTP cloud server,
// as Traefik does in production. The CA is written to -ca for the emulator's
// user trust store. Runner-only tooling; never shipped.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"time"
)

func main() {
	listen := flag.String("listen", ":443", "HTTPS listen address")
	backend := flag.String("backend", "http://127.0.0.1:8080", "plain-HTTP upstream")
	domain := flag.String("domain", "qa.test", "base domain; the leaf covers it and *.<domain>")
	caPath := flag.String("ca", "ca.pem", "where to write the CA certificate (PEM)")
	flag.Parse()

	up, err := url.Parse(*backend)
	if err != nil {
		slog.Error("bad -backend", "err", err)
		os.Exit(1)
	}
	names := append([]string{*domain, "*." + *domain}, flag.Args()...)
	cert, caPEM, err := issue(names)
	if err != nil {
		slog.Error("issue certificates", "err", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*caPath, caPEM, 0o644); err != nil {
		slog.Error("write CA", "path", *caPath, "err", err)
		os.Exit(1)
	}

	// NewSingleHostReverseProxy keeps the inbound Host header, which the cloud routes accounts by.
	proxy := httputil.NewSingleHostReverseProxy(up)
	// down.<domain> answers 503: the shell's "Can't reach your account" screen (N4), which a 404
	// no longer reaches (a 404 of the stored host returns to the first run, bd med-nt9p.32.14).
	// nobody.<domain> is the server's "no such account" 404, marked X-Account-Gone: 1 exactly as
	// internal/cloudserver/router.go's unknown-subdomain branch answers (the contract the shell
	// trusts); stale.<domain> is a proxy's bare 404 (Traefik's no-router answer during a redeploy),
	// which must NOT make the shell forget the account.
	down, gone, stale := "down."+*domain, "nobody."+*domain, "stale."+*domain
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Host {
		case down:
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		case gone:
			w.Header().Set("X-Account-Gone", "1")
			http.NotFound(w, r)
		case stale:
			http.NotFound(w, r)
		default:
			proxy.ServeHTTP(w, r)
		}
	})
	srv := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("tlsfront listening", "addr", *listen, "backend", *backend, "names", names, "ca", *caPath)
	if err := srv.ListenAndServeTLS("", ""); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

// issue mints a CA and a leaf for names signed by it; both live only for this run.
func issue(names []string) (tls.Certificate, []byte, error) {
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Med Tracker QA CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(7 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		return tls.Certificate{}, nil, err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(7 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, ca, &key.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	return tls.Certificate{Certificate: [][]byte{leafDER, caDER}, PrivateKey: key}, caPEM, nil
}
