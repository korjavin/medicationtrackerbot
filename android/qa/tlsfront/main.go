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
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"sync"
	"time"
)

func main() {
	listen := flag.String("listen", ":443", "HTTPS listen address")
	backend := flag.String("backend", "http://127.0.0.1:8080", "plain-HTTP upstream")
	domain := flag.String("domain", "qa.test", "base domain; the leaf covers it and *.<domain>")
	caPath := flag.String("ca", "ca.pem", "where to write the CA certificate (PEM)")
	receiptsPath := flag.String("receipts", "", "optional runner-only JSONL of received host/method/path (no query or body)")
	cloudA := flag.String("cloud-a", "", "B2 only: real stamped cloud A executable")
	cloudB := flag.String("cloud-b", "", "B2 only: real stamped cloud B executable")
	cloudLog := flag.String("cloud-log", "", "B2 only: append cloud process output here")
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
	// Only the runner can reach these controls. They are absent in ordinary QA runs.
	// This process retains the disposable DB/session environment through the serial swap;
	// no credential file and no simultaneous SQLite writers from two cloud generations.
	var fixture *recoveryFixture
	if *cloudA != "" || *cloudB != "" {
		fixture = &recoveryFixture{a: *cloudA, b: *cloudB, backend: up.String()}
		log, err := os.OpenFile(*cloudLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil || *cloudA == "" || *cloudB == "" {
			slog.Error("invalid B2 fixture", "err", err)
			os.Exit(1)
		}
		defer log.Close()
		fixture.log = log
		if err := fixture.start(*cloudA); err != nil {
			slog.Error("start cloud A", "err", err)
			os.Exit(1)
		}
		defer fixture.stop()
		control, err := net.Listen("tcp", "127.0.0.1:8766")
		if err != nil {
			slog.Error("listen B2 control", "err", err)
			os.Exit(1)
		}
		go func() {
			if err := http.Serve(control, http.HandlerFunc(fixture.control)); err != nil {
				slog.Error("B2 control", "err", err)
				os.Exit(1)
			}
		}()
	}
	// down.<domain> answers 503: the shell's "Can't reach your account" screen (N4), which a 404
	// no longer reaches (an X-Account-Gone 404 of the stored host returns to local mode with F1, bd med-nt9p.32.14, med-ta2n.12).
	// nobody.<domain> is the server's "no such account" 404, marked X-Account-Gone: 1 exactly as
	// internal/cloudserver/router.go's unknown-subdomain branch answers (the contract the shell
	// trusts); stale.<domain> is a proxy's bare 404 (Traefik's no-router answer during a redeploy),
	// which must NOT make the shell forget the account.
	down, gone, stale := "down."+*domain, "nobody."+*domain, "stale."+*domain
	var receipts *os.File
	var receiptsMu sync.Mutex
	if *receiptsPath != "" {
		receipts, err = os.OpenFile(*receiptsPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			slog.Error("open receipts", "err", err)
			os.Exit(1)
		}
		defer receipts.Close()
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Account routing still uses the original Host, as internal/cloudserver/router.go does.
		// Count BEFORE routing/proxying: even failed upstream and SW-owned requests are receipts.
		if receipts != nil {
			receiptsMu.Lock()
			err := json.NewEncoder(receipts).Encode(map[string]any{"at": time.Now().UTC(), "host": r.Host, "method": r.Method, "path": r.URL.Path})
			receiptsMu.Unlock()
			if err != nil {
				slog.Error("write receipts", "err", err)
				os.Exit(1)
			}
		}
		if fixture != nil && fixture.failModule(w, r) {
			return
		}
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

// recoveryFixture is bounded runner-only fixture state, never a cloud product API.
type recoveryFixture struct {
	mu              sync.Mutex
	a, b, backend   string
	log             io.Writer
	cmd             *exec.Cmd
	switched, armed bool
	host            string
	release         chan struct{}
	consumed        int
}

func (f *recoveryFixture) start(binary string) error {
	f.cmd = exec.Command(binary)
	f.cmd.Stdout, f.cmd.Stderr = f.log, f.log
	if err := f.cmd.Start(); err != nil {
		return err
	}
	client := &http.Client{Timeout: time.Second}
	for i := 0; i < 60; i++ {
		res, err := client.Get(f.backend + "/")
		if err == nil {
			res.Body.Close()
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("cloud did not listen")
}

func (f *recoveryFixture) stop() {
	if f.cmd != nil && f.cmd.Process != nil {
		_ = f.cmd.Process.Signal(os.Interrupt)
		_ = f.cmd.Wait()
		f.cmd = nil
	}
}

func (f *recoveryFixture) control(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == http.MethodPost {
		switch r.URL.Path {
		case "/switch-b":
			if !f.switched {
				f.stop()
				if err := f.start(f.b); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				f.switched = true
			}
		case "/arm":
			if f.armed || f.consumed != 0 {
				http.Error(w, "one fault per run", http.StatusConflict)
				return
			}
			var body struct {
				Host string `json:"host"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256)).Decode(&body) != nil || body.Host == "" {
				http.Error(w, "host required", http.StatusBadRequest)
				return
			}
			f.host, f.armed, f.release = body.Host, true, make(chan struct{})
		case "/release":
			if f.release != nil {
				close(f.release)
				f.release = nil
			}
		default:
			http.NotFound(w, r)
			return
		}
	} else if r.Method != http.MethodGet || r.URL.Path != "/status" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"switched": f.switched, "armed": f.armed, "consumed": f.consumed})
}

func (f *recoveryFixture) failModule(w http.ResponseWriter, r *http.Request) bool {
	f.mu.Lock()
	if !f.armed || r.Host != f.host || r.Method != http.MethodGet || r.URL.Path != "/js/apishim.js" {
		f.mu.Unlock()
		return false
	}
	f.armed = false
	f.consumed++
	release := f.release
	f.mu.Unlock()
	// State C's real waiting-worker banner must mount in the SAME document first.
	// Stay below the real SW's 5s header deadline; a late banner fails the scenario.
	select {
	case <-release:
	case <-time.After(4 * time.Second):
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "QA one-shot required-module failure", http.StatusServiceUnavailable)
	slog.Info("B2 one-shot consumed", "host", r.Host, "path", r.URL.Path, "status", 503)
	return true
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
