package cloudserver

import (
	"bufio"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// scriptedSMTP runs one SMTP session on ln (the stdlib smtp_test.go pattern):
// a fixed greeting and EHLO reply, then canned answers, recording every client
// line. It returns the transcript once the client quits or hangs up.
func scriptedSMTP(t *testing.T, ln net.Listener, ehlo string) <-chan []string {
	t.Helper()
	out := make(chan []string, 1)
	go func() {
		var lines []string
		defer func() { out <- lines }()
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		write := func(s string) { conn.Write([]byte(s + "\r\n")) }
		write("220 test ESMTP")
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			lines = append(lines, line)
			if inData {
				if line == "." {
					inData = false
					write("250 queued")
				}
				continue
			}
			switch cmd := strings.ToUpper(strings.Fields(line + " x")[0]); cmd {
			case "EHLO":
				write(ehlo)
			case "AUTH":
				write("235 ok")
			case "MAIL", "RCPT":
				write("250 ok")
			case "DATA":
				inData = true
				write("354 go")
			case "QUIT":
				write("221 bye")
				return
			default:
				write("502 no")
			}
		}
	}()
	return out
}

func TestSMTPMailer_RefusesWithoutSTARTTLS(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := scriptedSMTP(t, ln, "250-test\r\n250 AUTH PLAIN")
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	m := newSMTPMailer(SMTPConfig{Host: host, Port: port, Username: "u", Password: "p", From: "invites@example.com"})
	if err := m.send(t.Context(), "ada@example.com", "s", "b"); err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("send over plaintext = %v, want a STARTTLS refusal", err)
	}
	for _, l := range <-done {
		if strings.HasPrefix(l, "AUTH") || strings.HasPrefix(l, "MAIL") {
			t.Fatalf("sent %q to a relay without TLS", l)
		}
	}
}

func TestSMTPMailer_ImplicitTLSMessage(t *testing.T) {
	// Borrow httptest's self-signed 127.0.0.1 certificate and its trust pool.
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	cert, pool := srv.TLS.Certificates, srv.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	srv.Close()
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: cert})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := scriptedSMTP(t, ln, "250-test\r\n250 AUTH PLAIN")

	m := newSMTPMailer(SMTPConfig{Host: "127.0.0.1", Port: "465", Username: "u", Password: "p", From: "invites@example.com", FromName: "Med Tracker"})
	m.tls = &tls.Config{ServerName: "127.0.0.1", RootCAs: pool}
	m.addr = ln.Addr().String() // port "465" selects implicit TLS; dial the listener

	if err := m.send(t.Context(), "ada@example.com", "Your invite to example.com", "Open https://x.example.com/#claim=ab\n.\nbye"); err != nil {
		t.Fatalf("send: %v", err)
	}
	got := strings.Join(<-done, "\n")
	for _, want := range []string{
		"AUTH PLAIN", "MAIL FROM:<invites@example.com>", "RCPT TO:<ada@example.com>",
		`From: "Med Tracker" <invites@example.com>`, "To: <ada@example.com>", "Subject: Your invite to example.com",
		"MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Message-ID: <", "Date: ",
		"Open https://x.example.com/#claim=ab", "..", // dot-stuffed lone "."
	} {
		if !strings.Contains(got, want) {
			t.Errorf("transcript lacks %q:\n%s", want, got)
		}
	}
}

func TestSMTPConfigFromEnv(t *testing.T) {
	set := func(kv map[string]string) {
		for _, k := range []string{"SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_FROM_NAME"} {
			t.Setenv(k, kv[k])
		}
	}
	set(nil)
	if c, err := SMTPConfigFromEnv(); err != nil || c.Enabled() {
		t.Fatalf("all unset = %+v %v, want off and no error", c, err)
	}
	for name, kv := range map[string]map[string]string{
		"SMTP_FROM":     {"SMTP_HOST": "smtp.example.com"},
		"SMTP_HOST":     {"SMTP_FROM": "a@example.com"},
		"SMTP_PASSWORD": {"SMTP_HOST": "smtp.example.com", "SMTP_FROM": "a@example.com", "SMTP_USERNAME": "u"},
		"SMTP_PORT":     {"SMTP_HOST": "smtp.example.com", "SMTP_FROM": "a@example.com", "SMTP_PORT": "x"},
		"bare":          {"SMTP_HOST": "smtp.example.com", "SMTP_FROM": "Ops <a@example.com>"},
	} {
		set(kv)
		_, err := SMTPConfigFromEnv()
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%v → %v, want an error naming %s", kv, err, name)
		}
		if err != nil && strings.Contains(err.Error(), "smtp.example.com") {
			t.Errorf("error leaks a value: %v", err)
		}
	}
	set(map[string]string{"SMTP_HOST": "smtp.example.com", "SMTP_FROM": "a@example.com", "SMTP_USERNAME": "u", "SMTP_PASSWORD": "p"})
	if c, err := SMTPConfigFromEnv(); err != nil || !c.Enabled() || c.Port != "587" {
		t.Fatalf("full set = %+v %v, want on with port 587", c, err)
	}
}
