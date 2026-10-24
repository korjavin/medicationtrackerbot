package cloudserver

import (
	"bytes"
	"html"
	"net/http"
	"regexp"
	"strings"

	"github.com/korjavin/medicationtrackerbot/docs"
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

// privacyPage is docs/privacy-policy.md rendered once at startup. goldmark
// escapes raw HTML by default (no WithUnsafe), so the markdown cannot inject
// markup into the page.
var privacyPage = renderPrivacyPage(docs.PrivacyPolicy)

func renderPrivacyPage(md []byte) []byte {
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
<title>Med Tracker — Privacy Policy</title>
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

func servePrivacy(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Changes ship with a deploy; an hour of staleness is fine for a policy.
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(privacyPage)
}
