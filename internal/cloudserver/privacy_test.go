package cloudserver

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/docs"
)

// The public privacy policy (bd med-9u3s) is the base host's /privacy, rendered
// from docs/privacy-policy.md under the base host's unchanged strict CSP.
func TestRouter_PrivacyPage(t *testing.T) {
	t.Setenv("PRIVACY_CONTACT", "privacy@example.test")
	h := New("app.example.com", setupStore(t), testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	req := httptest.NewRequest(http.MethodGet, "/privacy", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	if csp, want := rec.Header().Get("Content-Security-Policy"), cspPolicy("connect-src 'self'", ""); csp != want {
		t.Errorf("CSP = %q, want the base default %q", csp, want)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"<title>MyHealthBot — Privacy Policy</title>",
		"<h1>MyHealthBot — Privacy Policy</h1>",
		"run by its developer",
		"<h2>8. Your rights, and deleting your data</h2>",
		"<table>",
		"<strong>Your health records are end-to-end encrypted.</strong>",
		"<code>app.example.com</code>",
		`<a href="mailto:privacy@example.test">privacy@example.test</a>`,
		"Last updated 2026-",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q", want)
		}
	}
	// Repo-relative links would 404 on this host; their text stays, the link goes.
	if strings.Contains(body, `href="cloud-mode.md`) {
		t.Error("relative cloud-mode.md link was not unwrapped")
	}
	if strings.Contains(body, "<script") {
		t.Error("privacy page must not carry script")
	}
}

// The policy text carries {{HOST}} / {{CONTACT}}; the deployment fills them in.
func TestRenderPrivacyPage_Placeholders(t *testing.T) {
	body := string(renderPrivacyPage(docs.PrivacyPolicy, "example.test", "privacy@example.test", "MyHealthBot", "its developer"))
	for _, want := range []string{"<code>example.test</code>", `<a href="mailto:privacy@example.test">`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q", want)
		}
	}
	if strings.Contains(body, "{{") {
		t.Error("unfilled placeholder in rendered page")
	}
}

func TestRenderPrivacyPage_NoContact(t *testing.T) {
	body := string(renderPrivacyPage(docs.PrivacyPolicy, "example.test", "", "MyHealthBot", "its developer"))
	if !strings.Contains(body, "the in-app feedback form") {
		t.Error("empty contact should point at the in-app feedback form")
	}
	if strings.Contains(body, "mailto:") || strings.Contains(body, "{{") {
		t.Error("empty contact must render no mailto link and no placeholder")
	}
}

func TestPrivacyContact_FallsBackToSMTPFrom(t *testing.T) {
	t.Setenv("PRIVACY_CONTACT", "")
	t.Setenv("SMTP_FROM", "invites@example.test")
	if got := privacyContact(); got != "invites@example.test" {
		t.Errorf("privacyContact() = %q", got)
	}
}

// No real domain or email address in repo docs (owner rule, bd med-to9x):
// write <base domain> / a placeholder, or a reserved example domain.
func TestDocs_NoRealDomainsOrEmails(t *testing.T) {
	domain := regexp.MustCompile(`(?i)[a-z0-9.-]*myhealthbot\.ai`)
	email := regexp.MustCompile(`(?i)[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}`)
	reserved := regexp.MustCompile(`(?i)@([a-z0-9-]+\.)*example\.(com|org|net|test)$`)
	root := filepath.Join("..", "..", "docs")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".md" {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range domain.FindAllString(string(b), -1) {
			t.Errorf("%s: real domain %q", path, m)
		}
		for _, m := range email.FindAllString(string(b), -1) {
			if !reserved.MatchString(m) {
				t.Errorf("%s: real email address %q", path, m)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRenderPrivacyPage_NameAndOperator(t *testing.T) {
	body := string(renderPrivacyPage(docs.PrivacyPolicy, "example.test", "", "Acme Health", "Acme Ltd"))
	for _, want := range []string{"<title>Acme Health — Privacy Policy</title>", "<h1>Acme Health — Privacy Policy</h1>", "run by Acme Ltd"} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q", want)
		}
	}
	if strings.Contains(body, "{{") {
		t.Error("unfilled placeholder")
	}
}

func TestRenderPrivacyPage_ContactNotEmailAndNoReexpansion(t *testing.T) {
	body := string(renderPrivacyPage(docs.PrivacyPolicy, "example.test", "not-an-email", "MyHealthBot", "its developer"))
	if strings.Contains(body, "not-an-email") || !strings.Contains(body, "the in-app feedback form") {
		t.Error("non-email contact must fall back to the feedback-form text")
	}
	body = string(renderPrivacyPage(docs.PrivacyPolicy, "example.test", "", "{{HOST}}", "its developer"))
	if !strings.Contains(body, "<h1>{{HOST}} — Privacy Policy</h1>") {
		t.Error("NAME value was re-expanded")
	}
	if !strings.Contains(body, "Last updated 2026-") {
		t.Error("effective date lost")
	}
}
