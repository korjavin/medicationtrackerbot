package cloudserver

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
)

// mailer sends the one email this server sends: the approved invite (bd
// med-ta2n.14). An interface only so tests can record sends.
type mailer interface {
	send(ctx context.Context, to, subject, body string) error
}

// SMTPConfig is the operator's relay (SMTP_* env, docs/environment.md).
type SMTPConfig struct {
	Host, Port, Username, Password, From, FromName string
}

// Enabled reports whether a relay is configured at all.
func (c SMTPConfig) Enabled() bool { return c.Host != "" }

// SMTPConfigFromEnv reads SMTP_*. All unset is a valid "off". A partial or
// malformed set returns an error naming the variables, never their values; the
// caller keeps the feature off rather than refusing to start.
func SMTPConfigFromEnv() (SMTPConfig, error) {
	c := SMTPConfig{
		Host: os.Getenv("SMTP_HOST"), Port: os.Getenv("SMTP_PORT"),
		Username: os.Getenv("SMTP_USERNAME"), Password: os.Getenv("SMTP_PASSWORD"),
		From: os.Getenv("SMTP_FROM"), FromName: os.Getenv("SMTP_FROM_NAME"),
	}
	if c.Port == "" {
		c.Port = "587"
	}
	switch {
	case c.Host == "" && c.From == "":
		return SMTPConfig{}, nil
	case c.Host == "" || c.From == "":
		return SMTPConfig{}, errors.New("SMTP_HOST and SMTP_FROM must be set together")
	case (c.Username == "") != (c.Password == ""):
		return SMTPConfig{}, errors.New("SMTP_USERNAME and SMTP_PASSWORD must be set together")
	}
	if n, err := strconv.Atoi(c.Port); err != nil || n <= 0 || n > 65535 {
		return SMTPConfig{}, errors.New("SMTP_PORT must be a port number")
	}
	if a, err := mail.ParseAddress(c.From); err != nil || a.Name != "" || a.Address != c.From {
		return SMTPConfig{}, errors.New("SMTP_FROM must be a bare email address")
	}
	if strings.ContainsAny(c.FromName, "\r\n") {
		return SMTPConfig{}, errors.New("SMTP_FROM_NAME must be one line")
	}
	return c, nil
}

// smtpMailer is the stdlib transport: implicit TLS on port 465, else STARTTLS
// required — a relay that offers no TLS gets nothing, credentials included.
type smtpMailer struct {
	cfg SMTPConfig
	tls  *tls.Config // nil → ServerName = cfg.Host; tests inject a RootCAs pool
	addr string      // "" → cfg.Host:cfg.Port; tests dial a listener
}

func newSMTPMailer(cfg SMTPConfig) *smtpMailer { return &smtpMailer{cfg: cfg} }

const smtpTimeout = 30 * time.Second

func (m *smtpMailer) send(ctx context.Context, to, subject, body string) error {
	tlsCfg := m.tls
	if tlsCfg == nil {
		tlsCfg = &tls.Config{ServerName: m.cfg.Host}
	}
	addr := m.addr
	if addr == "" {
		addr = net.JoinHostPort(m.cfg.Host, m.cfg.Port)
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	if m.cfg.Port == "465" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	deadline := time.Now().Add(smtpTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	conn.SetDeadline(deadline)
	c, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if m.cfg.Port != "465" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("smtp: relay does not offer STARTTLS")
		}
		if err := c.StartTLS(tlsCfg); err != nil {
			return err
		}
	}
	if m.cfg.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", m.cfg.Username, m.cfg.Password, m.cfg.Host)); err != nil {
			return err
		}
	}
	if err := c.Mail(m.cfg.From); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(m.message(to, subject, body)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// message renders one plain-text email. `to` was validated as a bare address
// with no CR/LF at the POST; the From name and subject are RFC 2047-encoded, so
// no header here can carry a line break.
func (m *smtpMailer) message(to, subject, body string) []byte {
	from := (&mail.Address{Name: m.cfg.FromName, Address: m.cfg.From}).String()
	id := make([]byte, 16)
	rand.Read(id)
	domain := m.cfg.From[strings.LastIndex(m.cfg.From, "@")+1:]
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\nTo: <%s>\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@%s>\r\n",
		from, to, mime.QEncoding.Encode("utf-8", subject), time.Now().Format(time.RFC1123Z), hex.EncodeToString(id), domain)
	b.WriteString("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n"))
	return []byte(b.String())
}

// mailErrorClass names a send failure for the admin chat without echoing the
// relay's reply text.
func mailErrorClass(err error) string {
	var tp *textproto.Error
	var ne net.Error
	switch {
	case errors.As(err, &tp):
		return "SMTP " + strconv.Itoa(tp.Code)
	case errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	case errors.As(err, new(*net.OpError)):
		return "connection failed"
	case errors.As(err, new(tls.RecordHeaderError)), errors.As(err, new(*tls.CertificateVerificationError)):
		return "TLS failed"
	default:
		return "send failed"
	}
}
