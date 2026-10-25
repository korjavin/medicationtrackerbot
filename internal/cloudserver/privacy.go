package cloudserver

import (
	"bytes"
	"html"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

// privacyPath is the public privacy policy (bd med-9u3s): the store listings
// and the native shells link https://<base>/privacy, so the policy no longer
// depends on the GitHub repo being public. Base host only, strict default CSP —
// the page is static HTML with no script.
const privacyPath = "/privacy"

var privacyEffective = regexp.MustCompile(`Effective (\d{4}-\d{2}-\d{2})`)

// privacyContact is the policy's contact address: PRIVACY_CONTACT, else
// SMTP_FROM. Empty = the page points at the in-app feedback form only.
func privacyContact() string {
	if c := os.Getenv("PRIVACY_CONTACT"); c != "" {
		return c
	}
	return os.Getenv("SMTP_FROM")
}

// privacyEnv returns env var k, or def when unset/empty.
func privacyEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// renderPrivacyPage renders docs/privacy-policy.md (once, in New) with the
// {{HOST}}, {{CONTACT}}, {{NAME}} and {{OPERATOR}} placeholders filled in before parsing, so the repo
// text carries no domain or address. goldmark escapes raw HTML by default (no
// WithUnsafe), so neither the markdown nor the env values can inject markup.
func renderPrivacyPage(md []byte, host, contact, name, operator string) []byte {
	s := string(md)
	if contact == "" {
		s = strings.ReplaceAll(s, "<{{CONTACT}}>", "the in-app feedback form")
	}
	s = strings.ReplaceAll(s, "{{CONTACT}}", contact)
	s = strings.ReplaceAll(s, "{{NAME}}", name)
	s = strings.ReplaceAll(s, "{{OPERATOR}}", operator)
	md = []byte(strings.ReplaceAll(s, "{{HOST}}", host))
	gm := goldmark.New(goldmark.WithExtensions(extension.Table))
	doc := gm.Parser().Parse(text.NewReader(md))
	// Repo-relative links (cloud-mode.md#…) resolve to nothing on this host;
	// keep their text, drop the link.
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if l, ok := n.(*ast.Link); ok && entering && !strings.Contains(string(l.Destination), "://") {
			p := l.Parent()
			for c := l.FirstChild(); c != nil; {
				next := c.NextSibling()
				p.InsertBefore(p, l, c)
				c = next
			}
			p.RemoveChild(p, l)
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	var body bytes.Buffer
	if err := gm.Renderer().Render(&body, md, doc); err != nil {
		panic("cloudserver: render privacy policy: " + err.Error())
	}
	var b bytes.Buffer
	b.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + html.EscapeString(name) + ` — Privacy Policy</title>
<link rel="stylesheet" href="/css/cloud.css">
<link rel="stylesheet" href="/static/css/fonts.css">
</head>
<body>
<main class="landing privacy">
`)
	b.Write(body.Bytes())
	if m := privacyEffective.FindSubmatch(md); m != nil {
		b.WriteString(`<footer class="muted">Last updated ` + html.EscapeString(string(m[1])) + ".</footer>\n")
	}
	b.WriteString("</main>\n</body>\n</html>\n")
	return b.Bytes()
}

func servePrivacy(w http.ResponseWriter, page []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Changes ship with a deploy; an hour of staleness is fine for a policy.
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(page)
}
