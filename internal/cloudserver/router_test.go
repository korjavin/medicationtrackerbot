package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	webstatic "github.com/korjavin/medicationtrackerbot/web/static"
)

// TestWorkletModulesAreEmbedded pins the deployment half of the script-src
// narrowing: elevenlabs-call.js hands the SDK explicit worklet paths, and the
// SDK does NOT fall back to a blob: when a given path fails — so a worklet
// missing from the embedded FS is a broken voice call, not a degraded one.
func TestWorkletModulesAreEmbedded(t *testing.T) {
	for _, name := range []string{
		"vendor/worklets/raw-audio-processor.js",
		"vendor/worklets/audio-concat-processor.js",
	} {
		b, err := webstatic.FS.ReadFile(name)
		if err != nil {
			t.Errorf("read %s from embedded web/static: %v", name, err)
			continue
		}
		if !strings.Contains(string(b), "registerProcessor(") {
			t.Errorf("%s does not register an AudioWorklet processor", name)
		}
	}

	// libsamplerate is the SDK's resampler module, loaded on any engine that
	// cannot pin the AudioContext sample rate (Firefox, Safari). It is not a
	// processor — it installs globalThis.LibSampleRate into the worklet scope,
	// which the concat processor then uses. Same all-or-nothing failure mode:
	// missing from the embedded FS means the CDN URL was the only source, and
	// script-src 'self' blocks that (bd med-yor.17).
	b, err := webstatic.FS.ReadFile("vendor/worklets/libsamplerate.worklet.js")
	if err != nil {
		t.Fatalf("read vendor/worklets/libsamplerate.worklet.js from embedded web/static: %v", err)
	}
	if !strings.Contains(string(b), "globalThis.LibSampleRate") {
		t.Error("libsamplerate.worklet.js does not install globalThis.LibSampleRate")
	}
}

// captureSlog points the default logger at h for the rest of the test, then
// restores a plain stderr logger.
//
// The restore is explicitly a NEW stderr logger, never the slog.Default() that
// was replaced — and that is the whole point of this helper. slog.SetDefault
// also redirects the standard log package's output into the handler it is
// given, and the built-in default handler writes back out through that same log
// package; handing the original default logger back to SetDefault therefore
// leaves the two wired into each other and every log line emitted afterwards in
// the process is swallowed (golang/go#61892).
//
// That is not a cosmetic problem here: it silenced the whole package. The first
// test to capture logs killed slog output for every test that ran after it, so
// the MCP relay's slog — the only diagnostic there is for a relay flake — never
// reached the CI log even when the run failed (bd med-tc1.12).
func captureSlog(t *testing.T, h slog.Handler) {
	t.Helper()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil))) })
}

func setupStore(t *testing.T) *cloudstore.Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := cloudstore.New(d)
	if err != nil {
		t.Fatalf("cloudstore.New: %v", err)
	}
	return r
}

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":       {Data: []byte("landing page")},
		"signup.html":      {Data: []byte("account shell")},
		"share.html":       {Data: []byte(`<body data-page="share-landing">`)},
		"invite.html":      {Data: []byte(`<html><head></head><body data-page="invite-landing"></body></html>`)},
		"handoff.html":     {Data: []byte(`<html><head></head><body data-page="handoff-landing"></body></html>`)},
		"css/cloud.css":    {Data: []byte("body{}")},
		"js/cloud-boot.js": {Data: []byte("window.__MEDTRACKER_CLOUD__=true;")},
	}
}

func testAppFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<html><head></head><body>real app</body></html>")},
		"js/app.js":  {Data: []byte("console.log(1)")},
	}
}

func testDomainFS() fstest.MapFS {
	return fstest.MapFS{
		"bp.js":     {Data: []byte("export const createBPDomain = () => ({});")},
		"weight.js": {Data: []byte("export const createWeightDomain = () => ({});")},
	}
}

func TestRouter_InstanceProductName(t *testing.T) {
	store := setupStore(t)
	for _, tc := range []struct{ name, env, escaped string }{
		{"default", "", "MyHealthBot"},
		{"configured and escaped", `Example "Health" <Care> & Co`, `Example &#34;Health&#34; &lt;Care&gt; &amp; Co`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PRIVACY_NAME", tc.env)
			h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
			want := `<meta name="medtracker-product-name" content="` + tc.escaped + `">`
			if !strings.Contains(string(h.appIndex), want) {
				t.Fatalf("missing escaped instance identity %q in app document: %s", want, h.appIndex)
			}
			if !strings.Contains(string(h.privacyPage), tc.escaped) {
				t.Fatal("privacy page and voice metadata must use the same instance identity")
			}
		})
	}
}

// med-eas.52: the base-domain landing page grows an optional "request an
// invite" contact line, injected before </main> only when the operator sets
// REQUEST_INVITE_EMAIL (via SetRequestInviteEmail). Unset = byte-identical to
// today; the address is HTML-escaped in both the visible text and the mailto
// href.
func TestRouter_RequestInviteEmail(t *testing.T) {
	store := setupStore(t)
	landingFS := fstest.MapFS{
		"index.html":  {Data: []byte(`<main class="landing"><h1>Invitations only</h1></main>`)},
		"signup.html": {Data: []byte("account shell")},
	}
	get := func(t *testing.T, h *Handler) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = "app.example.com"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		return rec.Body.String()
	}

	t.Run("unset renders no contact line", func(t *testing.T) {
		h := New("app.example.com", store, landingFS, testAppFS(), testDomainFS(), nil, "", false, false)
		if body := get(t, h); strings.Contains(body, "mailto:") {
			t.Fatalf("unset env leaked a mailto link: %q", body)
		}
	})

	t.Run("set renders the escaped mailto line", func(t *testing.T) {
		h := New("app.example.com", store, landingFS, testAppFS(), testDomainFS(), nil, "", false, false)
		h.SetRequestInviteEmail("ops@example.com")
		body := get(t, h)
		if !strings.Contains(body, `mailto:ops@example.com`) {
			t.Fatalf("missing mailto href: %q", body)
		}
		if !strings.Contains(body, ">ops@example.com<") {
			t.Fatalf("missing visible address: %q", body)
		}
	})

	t.Run("injection payload is HTML-escaped", func(t *testing.T) {
		h := New("app.example.com", store, landingFS, testAppFS(), testDomainFS(), nil, "", false, false)
		h.SetRequestInviteEmail(`a"><script>@x.test`)
		body := get(t, h)
		if strings.Contains(body, `<script>@x.test`) {
			t.Fatalf("payload escaped incorrectly, injection possible: %q", body)
		}
		if !strings.Contains(body, "&lt;script&gt;") || !strings.Contains(body, "&#34;") {
			t.Fatalf("expected escaped form not present: %q", body)
		}
	})
}

// With no TRIAL_* envs configured the served index must carry no trial
// markers at all — behavior is byte-identical to pure BYO.
func TestRouter_TrialFlagsOff_NoTrialMetas(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "https://food.example.com", false, false)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "known-sub.app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "medtracker-trial") {
		t.Fatalf("index with trial flags off leaks trial markers: %q", rec.Body.String())
	}
}

func TestRouter_HostVariants(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	if _, err := store.CreateAccount(ctx, "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "https://food.example.com", true, true)

	cases := []struct {
		name       string
		host       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"base domain serves landing page", "app.example.com", "/", http.StatusOK, "landing page"},
		{"base domain with dev port", "app.example.com:8080", "/", http.StatusOK, "landing page"},
		// The base domain answers /api/version with the same build id as the
		// subdomains — it is what CI polls to prove a Portainer redeploy landed
		// (bd med-m391), and there is no account to scope it to.
		{"base domain serves the build id", "app.example.com", "/api/version", http.StatusOK, "{\"build_id\":\"dev\"}\n"},
		{"known subdomain serves the real app at root", "known-sub.app.example.com", "/", http.StatusOK, "<html><head>\n    <meta name=\"medtracker-food-db\" content=\"1\">\n    <meta name=\"medtracker-build-id\" content=\"dev\">\n    <meta name=\"medtracker-product-name\" content=\"MyHealthBot\">\n    <meta name=\"medtracker-trial-ai\" content=\"1\">\n    <meta name=\"medtracker-trial-voice\" content=\"1\">\n    <script src=\"/js/cloud-boot.js\"></script>\n    <script type=\"module\" src=\"/js/update-check.js\"></script></head><body>real app</body></html>"},
		{"known subdomain serves the unlock shell", "known-sub.app.example.com", "/unlock", http.StatusOK, "account shell"},
		{"known subdomain claim serves the shell", "known-sub.app.example.com", "/claim", http.StatusOK, "account shell"},
		{"known subdomain recover serves the shell", "known-sub.app.example.com", "/recover", http.StatusOK, "account shell"},
		{"known subdomain devices serves the shell", "known-sub.app.example.com", "/devices", http.StatusOK, "account shell"},
		{"known subdomain connectors serves the shell", "known-sub.app.example.com", "/connectors", http.StatusOK, "account shell"},
		{"known subdomain app asset resolves", "known-sub.app.example.com", "/static/js/app.js", http.StatusOK, "console.log(1)"},
		{"known subdomain domain module resolves", "known-sub.app.example.com", "/domain/bp.js", http.StatusOK, "export const createBPDomain = () => ({});"},
		{"known subdomain cloud-boot.js resolves via shell fallback", "known-sub.app.example.com", "/js/cloud-boot.js", http.StatusOK, "window.__MEDTRACKER_CLOUD__=true;"},
		{"unknown subdomain is 404", "no-such-sub.app.example.com", "/", http.StatusNotFound, ""},
		{"unknown subdomain api is 404", "no-such-sub.app.example.com", "/api/version", http.StatusNotFound, ""},
		{"known subdomain missing asset is 404", "known-sub.app.example.com", "/static/js/nope.js", http.StatusNotFound, ""}, {"unrelated host is 404", "evil.example.org", "/", http.StatusNotFound, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Host = tc.host
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			wantBody := tc.wantBody
			if tc.path == "/" && strings.HasSuffix(tc.host, ".app.example.com") && tc.wantStatus == http.StatusOK {
				wantBody = strings.Replace(wantBody, "<head>", "<head>\n    <meta name=\"medtracker-connect-origins\" content=\"[&#34;https://api.elevenlabs.io&#34;]\">", 1)
			}
			if wantBody != "" && rec.Body.String() != wantBody {
				t.Fatalf("body = %q, want %q", rec.Body.String(), wantBody)
			}

			// The no-such-account marker (bd med-nt9p.32.14): only on the
			// unknown-subdomain 404, never on a live account or another 404.
			gone := rec.Header().Get("X-Account-Gone")
			if wantGone := tc.name == "unknown subdomain is 404" || tc.name == "unknown subdomain api is 404"; (gone == "1") != wantGone {
				t.Errorf("X-Account-Gone = %q, want set: %v", gone, wantGone)
			}

			if tc.name == "known subdomain serves the real app at root" {
				if cc := rec.Header().Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
					t.Errorf("Cache-Control = %q, want no-cache, no-store, must-revalidate", cc)
				}
			}
			// Every response on the E2EE origin must carry the hardening headers,
			// including 404s (docs/cloud-crypto.md rates on-origin XSS catastrophic).
			csp := rec.Header().Get("Content-Security-Policy")
			if csp == "" {
				t.Errorf("missing Content-Security-Policy header")
			}
			// Only the account-subdomain app DOCUMENT ("/") relaxes its policy:
			// connect-src is scoped to this account's registered provider hosts
			// (none in this account) + the fixed ElevenLabs host — never a bare
			// https:. Its same-origin assets (/static/*, /domain/*) don't initiate
			// the app's fetches, so they stay strict 'self'. The base domain and
			// the passkey ceremony pages make no cross-origin calls and stay strict.
			wantConnect := "connect-src 'self';"
			// A 404 host never reaches the app-document branch (the account
			// doesn't resolve), so it keeps the strict default — only a served "/"
			// on a known subdomain carries the scoped allowlist.
			appDocument := tc.wantStatus == http.StatusOK &&
				stripPort(tc.host) != "app.example.com" && tc.path == "/"
			if appDocument {
				wantConnect = "connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io;"
			}
			if !strings.Contains(csp, wantConnect) {
				t.Errorf("CSP connect-src = %q, want it to contain %q", csp, wantConnect)
			}
			// connect-src is now the ONLY directive the app document relaxes.
			// The app document loads the @elevenlabs/client voice SDK, but from
			// our own origin (vendored) and with self-hosted worklet modules, so
			// script-src is a plain 'self' everywhere (bd med-yor.8).
			if !strings.Contains(csp, "script-src 'self';") {
				t.Errorf("CSP script-src = %q, want it to contain %q", csp, "script-src 'self';")
			}
			// med-7e7.1: no third-party script host may ever appear in script-src.
			// These pages hold the in-memory DEK, and docs/cloud-crypto.md rates
			// on-origin XSS as catastrophic — a foreign script host reintroduces
			// exactly that. Vendor the dependency instead (web/static/vendor/).
			// Asserted on the directive, not the whole header: connect-src
			// legitimately carries https: for BYO provider calls.
			scriptSrc := cspDirective(csp, "script-src")
			if strings.Contains(scriptSrc, "//") {
				t.Errorf("script-src = %q, want no third-party script host (vendor it instead)", scriptSrc)
			}
			// The whole point of the egress allowlist: even the app document must
			// never carry a bare `https:`/`wss:` connect-src token (that is the
			// arbitrary-origin exfil gadget). Every host is a full https://<host>.
			if bare := bareSchemeToken(cspDirective(csp, "connect-src")); bare != "" {
				t.Errorf("connect-src = %q carries bare %q token (arbitrary-origin exfil gadget)", cspDirective(csp, "connect-src"), bare)
			}
			if xcto := rec.Header().Get("X-Content-Type-Options"); xcto != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", xcto)
			}
		})
	}
}

// TestRouter_AppDocumentReflectsEgressHosts is the with-hosts counterpart to
// TestRouter_HostVariants: once an account has registered provider hosts, the "/"
// document's connect-src lists exactly those (as https://<host>) plus the fixed
// ElevenLabs host — and still no bare https:/wss: token. Assets on the same origin
// stay strict 'self'.
func TestRouter_AppDocumentReflectsEgressHosts(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	if _, err := store.CreateAccount(ctx, "acc-eg", "eg-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if err := store.SetEgressHosts(ctx, "acc-eg", []string{"api.openai.com", "fooddb.example.com"}); err != nil {
		t.Fatalf("SetEgressHosts: %v", err)
	}

	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "https://food.example.com", true, true)

	// App document ("/") reflects the stored hosts.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "eg-sub.app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	connect := cspDirective(rec.Header().Get("Content-Security-Policy"), "connect-src")
	want := "'self' https://api.openai.com https://fooddb.example.com https://api.elevenlabs.io wss://api.elevenlabs.io"
	if connect != want {
		t.Fatalf("connect-src = %q, want %q", connect, want)
	}
	if got := appDocumentOrigins(t, rec.Body.String()); !slices.Equal(got, []string{"https://api.openai.com", "https://fooddb.example.com", "https://api.elevenlabs.io"}) {
		t.Fatalf("loaded-document origins = %v, want HTTPS sources from %q", got, connect)
	}
	if strings.Contains(string(h.appIndex), "medtracker-connect-origins") {
		t.Fatal("per-account policy leaked into cached app template")
	}
	for _, tok := range []string{"'self'", "https://api.openai.com", "https://fooddb.example.com", "https://api.elevenlabs.io", "wss://api.elevenlabs.io"} {
		if !strings.Contains(connect, tok) {
			t.Errorf("connect-src = %q, missing %q", connect, tok)
		}
	}
	if bare := bareSchemeToken(connect); bare != "" {
		t.Errorf("connect-src = %q carries bare %q token", connect, bare)
	}

	// A same-origin asset ("/static/*") does not initiate the app's fetches, so it
	// keeps the strict default even for a host-carrying account.
	req = httptest.NewRequest(http.MethodGet, "/static/js/app.js", nil)
	req.Host = "eg-sub.app.example.com"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := cspDirective(rec.Header().Get("Content-Security-Policy"), "connect-src"); got != "'self'" {
		t.Errorf("asset connect-src = %q, want strict 'self'", got)
	}
}

func appDocumentOrigins(t *testing.T, body string) []string {
	t.Helper()
	const marker = `<meta name="medtracker-connect-origins" content="`
	_, tail, ok := strings.Cut(body, marker)
	if !ok {
		t.Fatal("app document has no loaded-policy metadata")
	}
	value, _, ok := strings.Cut(tail, `"`)
	if !ok {
		t.Fatal("unterminated policy metadata")
	}
	var origins []string
	if err := json.Unmarshal([]byte(html.UnescapeString(value)), &origins); err != nil {
		t.Fatalf("decode escaped origins: %v", err)
	}
	return origins
}

type failedEgressReadStore struct{ *cloudstore.Repo }

func (s failedEgressReadStore) EgressHosts(context.Context, string) ([]string, error) {
	// A partial failed read must not claim or grant the partial host list.
	return []string{"partial.example.com"}, errors.New("fixture egress read failure")
}

func TestRouter_AppDocumentOriginsRemainResponseScoped(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	for _, id := range []string{"one", "two", "empty"} {
		if _, err := store.CreateAccount(t.Context(), id, id, []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	for id, hosts := range map[string][]string{"one": {"one.example.com"}, "two": {"two.example.com"}} {
		if err := store.SetEgressHosts(t.Context(), id, hosts); err != nil {
			t.Fatal(err)
		}
	}
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	cached := string(h.appIndex)
	for _, id := range []string{"one", "two", "empty", "one", "two"} {
		req := httptest.NewRequest(http.MethodGet, "https://"+id+".app.example.com/", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := []string{"https://api.elevenlabs.io"}
		if id != "empty" {
			want = append([]string{"https://" + id + ".example.com"}, want...)
		}
		if got := appDocumentOrigins(t, rec.Body.String()); !slices.Equal(got, want) {
			t.Fatalf("account %s metadata = %v, want %v", id, got, want)
		}
		for _, origin := range want {
			if !strings.Contains(cspDirective(rec.Header().Get("Content-Security-Policy"), "connect-src"), origin) {
				t.Fatalf("metadata origin %q absent from actual header", origin)
			}
		}
		if string(h.appIndex) != cached {
			t.Fatal("request mutated cached app bytes")
		}
	}
	h = New("app.example.com", failedEgressReadStore{store}, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "https://one.app.example.com/", nil))
	if got := appDocumentOrigins(t, rec.Body.String()); !slices.Equal(got, []string{"https://api.elevenlabs.io"}) {
		t.Fatalf("read-error origins = %v", got)
	}
	if strings.Contains(rec.Header().Get("Content-Security-Policy"), "partial.example.com") {
		t.Fatal("read-error header granted partial host")
	}
	// Even unexpected stored text is attribute-escaped; it cannot close a meta
	// tag or create markup. The client rejects malformed origin capabilities.
	crafted := appDocumentWithConnectOrigins([]byte("<html><head></head></html>"), []string{`x\"><script>fixture</script>`})
	if strings.Contains(string(crafted), "<script>fixture") {
		t.Fatal("policy text escaped its HTML attribute")
	}
}

// The feedback recipient pubkey reaches the browser via a <meta> tag on the app
// document only when SetFeedbackRecipient was given a non-empty value; the value
// is HTML-escaped, and enabling feedback must not widen the app document's scoped
// connect-src (feedback POSTs to same-origin /api/feedback). bd med-dni.1.
func TestRouter_FeedbackRecipientMeta(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	appDoc := func(h *Handler) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = "known-sub.app.example.com"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		return rec
	}

	const metaName = `<meta name="medtracker-feedback-age-recipient"`

	t.Run("recipient set emits the escaped meta and does not widen connect-src", func(t *testing.T) {
		h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
		h.SetFeedbackRecipient("age1abc<>&\"def")
		rec := appDoc(h)

		body := rec.Body.String()
		want := metaName + ` content="age1abc&lt;&gt;&amp;&#34;def">`
		if !strings.Contains(body, want) {
			t.Fatalf("app document missing escaped feedback meta %q in:\n%s", want, body)
		}
		connect := cspDirective(rec.Header().Get("Content-Security-Policy"), "connect-src")
		if bare := bareSchemeToken(connect); bare != "" {
			t.Errorf("connect-src = %q carries bare %q token after enabling feedback", connect, bare)
		}
	})

	t.Run("recipient unset emits no meta", func(t *testing.T) {
		h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
		h.SetFeedbackRecipient("")
		if body := appDoc(h).Body.String(); strings.Contains(body, metaName) {
			t.Fatalf("app document leaks feedback meta when recipient is unset:\n%s", body)
		}
	})
}

// TestSecurityHeaders_NoBlobOrDataScript pins the script-execution half of the
// CSP: no document on the E2EE origin — app document included — may load or
// evaluate script from anywhere but 'self'. The DEK lives in this document's
// memory, so every extra source here is a route to it.
//
// This exists because the allowance already regressed once: the ElevenLabs SDK
// builds its AudioWorklets from blob: URLs (with a data: fallback), no engine
// ships `worklet-src`, and those loads therefore land on script-src — which is
// why the app document used to serve `script-src 'self' blob: data:`. The fix
// (bd med-yor.8) self-hosts the worklet modules and hands the SDK their paths
// (web/static/js/features/elevenlabs-call.js), so nothing mints script from a
// blob:/data: URL any more. If a future SDK bump quietly needs the widening
// back, this test is where it must be argued for, not silently re-added.
func TestSecurityHeaders_NoBlobOrDataScript(t *testing.T) {
	// Directives a script can execute through. img-src/font-src are deliberately
	// not listed: a data: image is not code.
	scriptish := []string{"default-src", "script-src", "worker-src", "child-src"}
	banned := []string{"blob:", "data:", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "*"}

	for _, appDocument := range []bool{false, true} {
		rec := httptest.NewRecorder()
		setSecurityHeaders(rec, appDocument, []string{"api.openai.com"})
		csp := rec.Header().Get("Content-Security-Policy")
		for _, name := range scriptish {
			value := cspDirective(csp, name)
			if value == "" {
				continue // absent directive falls back to default-src, checked above
			}
			for _, tok := range banned {
				if slices.Contains(strings.Fields(value), tok) {
					t.Errorf("appDocument=%v: %s = %q carries %q — that is script execution reachable from the in-memory DEK", appDocument, name, value, tok)
				}
			}
			if strings.Contains(value, "//") {
				t.Errorf("appDocument=%v: %s = %q names a foreign host (vendor it instead)", appDocument, name, value)
			}
		}
	}
}

// bareSchemeToken returns a bare `https:`/`wss:` token if the CSP directive value
// carries one (i.e. a scheme not followed by `//host`), or "" if every token is a
// concrete origin. This is the exfil-gadget guard for connect-src.
func bareSchemeToken(directive string) string {
	for _, tok := range strings.Fields(directive) {
		if tok == "https:" || tok == "wss:" || tok == "http:" || tok == "ws:" {
			return tok
		}
	}
	return ""
}

// cspDirective returns the value of one CSP directive (without its name), or ""
// when the policy does not carry it.
func cspDirective(csp, name string) string {
	for _, part := range strings.Split(csp, ";") {
		part = strings.TrimSpace(part)
		if after, ok := strings.CutPrefix(part, name+" "); ok {
			return after
		}
	}
	return ""
}

// TestRouter_ShareLanding (med-1yi5): GET /s/{id} on the base domain serves
// the share landing shell with no-store and the default strict CSP
// (connect-src 'self', no bare https:). Any id shape serves the page — the
// page itself reports unknown/expired ids from the API.
func TestRouter_ShareLanding(t *testing.T) {
	store := setupStore(t)
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)

	for _, path := range []string{"/s/Ab3kZ9xQ2m", "/s/short", "/s/way-too-long-an-id"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = "app.example.com"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200 (body %q)", path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `data-page="share-landing"`) {
			t.Fatalf("GET %s body = %q, want data-page=\"share-landing\"", path, rec.Body.String())
		}
		csp := rec.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "connect-src 'self'") {
			t.Errorf("GET %s CSP = %q, want connect-src 'self'", path, csp)
		}
		if bare := bareSchemeToken(cspDirective(csp, "connect-src")); bare != "" {
			t.Errorf("GET %s connect-src carries bare %q token", path, bare)
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Errorf("GET %s Cache-Control = %q, want no-store", path, cc)
		}
	}

	// With no API mounted, the base-domain /api/s/ forward 404s instead of
	// serving the shell.
	req := httptest.NewRequest(http.MethodGet, "/api/s/Ab3kZ9xQ2m", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/s/<id> with nil api = %d, want 404", rec.Code)
	}
}

// bd med-ta2n.2: the claim wizard no longer offers the trial (the app's first
// run does), so the passkey shell is served as-is — no trial-AI meta, whatever
// the operator configured.
func TestRouter_ShellCarriesNoTrialAI(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	shellFS := testFS()
	shellFS["signup.html"] = &fstest.MapFile{Data: []byte("<html><head></head><body>shell</body></html>")}
	for _, trial := range []bool{true, false} {
		h := New("app.example.com", store, shellFS, testAppFS(), testDomainFS(), nil, "", trial, false)
		req := httptest.NewRequest(http.MethodGet, "/unlock", nil)
		req.Host = "known-sub.app.example.com"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("trial=%v: status = %d", trial, rec.Code)
		}
		has := strings.Contains(rec.Body.String(), `medtracker-trial-ai`)
		if has {
			t.Fatalf("trial=%v: meta present = %v; body %q", trial, has, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "shell") {
			t.Fatalf("trial=%v: shell body missing: %q", trial, rec.Body.String())
		}
	}
}

// The operator's food-DB host is private: the served document carries only a
// flag (bd med-wa9c), never the CLOUD_FOOD_DB_URL value or its host.
func TestInjectCloudBoot_FoodDBHostNeverServed(t *testing.T) {
	const secret = "https://private-food.internal.example"
	out := string(injectCloudBoot([]byte("<html><head></head></html>"), secret, false, false, "dev", "MyHealthBot"))
	if strings.Contains(out, secret) || strings.Contains(out, "private-food") {
		t.Fatalf("document leaks the food-DB URL: %s", out)
	}
	if !strings.Contains(out, `<meta name="medtracker-food-db" content="1">`) {
		t.Errorf("configured flag missing: %s", out)
	}
	if out := string(injectCloudBoot([]byte("<html><head></head></html>"), "", false, false, "dev", "MyHealthBot")); strings.Contains(out, "medtracker-food-db") {
		t.Errorf("flag emitted with no food DB configured: %s", out)
	}
}

// TestRouter_InviteLanding pins the /i/<sub> landing route (med-ta2n.9): base
// domain only, well-formed subdomains only, no-store, the strict default CSP,
// and the store-id metas present exactly when configured (HTML-escaped).
func TestRouter_InviteLanding(t *testing.T) {
	store := setupStore(t)
	get := func(h *Handler, host, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	isLanding := func(rec *httptest.ResponseRecorder) bool {
		return rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), `data-page="invite-landing"`)
	}

	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetInviteStoreIDs("", "")
	rec := get(h, "app.example.com", "/i/brave-otter-abc123")
	if !isLanding(rec) {
		t.Fatalf("GET /i/<sub> = %d %q, want the invite page", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "medtracker-ios-app-store-id") || strings.Contains(rec.Body.String(), "medtracker-android-package") {
		t.Fatalf("unset store ids emitted a meta: %q", rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); csp != cspPolicy("connect-src 'self'", "") {
		t.Errorf("CSP = %q, want the strict default", csp)
	}
	for _, path := range []string{"/i/", "/i/Brave-Otter", "/i/a/b", "/i/a.b"} {
		if isLanding(get(h, "app.example.com", path)) {
			t.Errorf("GET %s served the invite page, want no match", path)
		}
	}

	h = New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetInviteStoreIDs("1234567890", `com.example."app"`)
	body := get(h, "app.example.com", "/i/brave-otter-abc123").Body.String()
	for _, want := range []string{
		`<meta name="medtracker-ios-app-store-id" content="1234567890">`,
		`<meta name="medtracker-android-package" content="com.example.&#34;app&#34;">`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("invite page missing %s: %q", want, body)
		}
	}
}

// The add-device hand-off (bd med-r1j2.4): https://<base>/d/<sub> serves the
// static landing with the strict default CSP (never a wildcard connect-src),
// the store metas, no-store, and nothing on an account host.
func TestRouter_HandoffLanding(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	get := func(h *Handler, host, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	isLanding := func(rec *httptest.ResponseRecorder) bool {
		return rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), `data-page="handoff-landing"`)
	}

	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	for _, host := range []string{"app.example.com", "app.example.com:8080"} {
		rec := get(h, host, "/d/known-sub")
		if !isLanding(rec) {
			t.Fatalf("%s GET /d/<sub> = %d %q, want the hand-off page", host, rec.Code, rec.Body.String())
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Errorf("Cache-Control = %q, want no-store", cc)
		}
		csp := rec.Header().Get("Content-Security-Policy")
		if csp != cspPolicy("connect-src 'self'", "") || strings.Contains(csp, "https:;") || strings.Contains(csp, " https: ") || strings.Contains(csp, "wss:") {
			t.Errorf("CSP = %q, want the strict default", csp)
		}
	}
	for _, path := range []string{"/d/", "/d/Known-Sub", "/d/a/b", "/d/a.b"} {
		if isLanding(get(h, "app.example.com", path)) {
			t.Errorf("GET %s served the hand-off page, want no match", path)
		}
	}
	// Base domain only: an account host has no /d/ landing.
	if isLanding(get(h, "known-sub.app.example.com", "/d/known-sub")) {
		t.Error("account host served the hand-off page")
	}
	// The page's Path 0 link reads InviteSheet.parseAddress from the base domain.
	if !baseDomainStaticAssets["/static/js/features/invite.js"] {
		t.Error("base domain does not serve features/invite.js")
	}

	if strings.Contains(get(h, "app.example.com", "/d/known-sub").Body.String(), "medtracker-handoff-app") {
		t.Error("app-links meta emitted while off")
	}
	// The account app document carries the flag too (add-device origin, med-r1j2.13).
	if strings.Contains(get(h, "known-sub.app.example.com", "/").Body.String(), "medtracker-handoff-app") {
		t.Error("app document has the app-links meta while off")
	}
	h.SetHandoffAppLinks(false)
	h.SetInviteStoreIDs("1234567890", "com.example.app")
	h.SetHandoffAppLinks(true)
	body := get(h, "app.example.com", "/d/known-sub").Body.String()
	if !strings.Contains(body, `<meta name="medtracker-handoff-app" content="1">`) {
		t.Errorf("hand-off page missing the app-links meta: %q", body)
	}
	if !strings.Contains(get(h, "known-sub.app.example.com", "/").Body.String(), `<meta name="medtracker-handoff-app" content="1">`) {
		t.Error("app document missing the app-links meta while on")
	}
	for _, want := range []string{
		`<meta name="medtracker-ios-app-store-id" content="1234567890">`,
		`<meta name="medtracker-android-package" content="com.example.app">`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("hand-off page missing %s: %q", want, body)
		}
	}
}
