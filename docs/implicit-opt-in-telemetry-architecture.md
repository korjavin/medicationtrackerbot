# Implicit Opt-In Telemetry Architecture

Status: **Design — implementation pending.** All open questions resolved; see [Decisions](#decisions). v1 ships with **Option A** (Vince, fleet-aggregate); a future custom dashboard against Vince's raw data (Option C) remains an upgrade path if the aggregate view proves insufficient. See [Backend Selection](#backend-selection-decided-option-a).

## Problem

MedTracker is self-hosted by multiple operators, each running their own single-user instance. As the maintainer, I have zero visibility into how the app is actually used:

- Which screens get the most traffic?
- Which features are adopted vs. ignored?
- What's the version adoption curve across the fleet?
- Are there error patterns that only surface at scale?

Without this, feature decisions are guesswork. But the answer cannot come at the cost of operator privacy — self-hosters chose MedTracker precisely because they own their data.

## Design Philosophy

1. **Single-user self-hosted = the operator IS the data subject.** Each canonical MedTracker instance is run by one person who is also its only user. Consent is therefore unambiguous: the operator opts themselves in via env var on their own machine. No multi-tenant consent layer is needed; GDPR-style "explicit consent" is satisfied by the env-var toggle. (A self-hoster running a non-canonical multi-user fork takes on data-controller obligations for their users; this design covers only the canonical shape.)
2. **Implicit opt-in by default.** Telemetry is off unless the operator sets `TELEMETRY_ENABLED=true`. No phone-home on first boot. No nag screen. No analytics JS loaded for opted-out instances.
3. **Zero PHI / identifying data.** No health values, no domain names, no IPs, no headers, no Telegram IDs, no medication names. Ever.
4. **Aggregate + per-instance, never per-patient.** We identify instances (to compare adoption curves) but never the human inside the instance — there's only one human per instance, and they consented to be counted.
5. **Transparent and auditable.** Every event name and prop is in a code allowlist plus this doc.
6. **Fire-and-forget.** Telemetry never blocks a request, never retries, never persists to disk. Buffer full → drop.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Operator's self-hosted instance                          │
│                                                          │
│  Browser ───sendBeacon──→ /api/telemetry/event           │
│                              │                           │
│  Telegram bot ──┐            │                           │
│  Scheduler ─────┼───→ telemetry.Reporter ←── HTTP mw     │
│  SSE stream ────┘            │                           │
│                              │  • install-time instance ID│
│                              │  • bounded buffer (drops)  │
│                              │  • dedup of deployment     │
│                              └──────────┬─────────────────│
│                                         │                │
└─────────────────────────────────────────┼────────────────┘
                                          │
            HTTPS, fixed UA, synthetic X-Forwarded-For
                                          │
┌─────────────────────────────────────────┼────────────────┐
│ Central Vince instance (maintainer)     │                │
│                                         ▼                │
│  POST /api/event  (Plausible-compatible)                 │
│    domain = "telemetry.example.com"  ← single site            │
│    props.instance = <hex>       ← per-instance breakdown │
└──────────────────────────────────────────────────────────┘
```

### Key design decisions

**Backend proxy, not frontend-direct.** The browser never talks to the central Vince server. All events go through the Go backend, which strips identifying context and forwards a sanitized payload.

**Install-time persistent instance ID.** Each instance has a stable hex ID generated *once at install time* and reused for the life of the instance. Rotation is operator-initiated only.

- The installer (see [docs/installer.md](installer.md)) generates `TELEMETRY_INSTANCE_ID=$(openssl rand -hex 8)` and writes it to the `.env` / Compose env alongside other install-time secrets. Telemetry stays off; the ID is just provisioned so it's stable if the operator later opts in.
- On startup, if the env var is unset, the reporter lazy-generates a random ID and persists it to the `settings` table (key `telemetry_instance_id`). This covers upgrades from versions before the installer set the var.
- The ID is never derived from hostname, MAC, public key, install date, or any identifying attribute. It carries zero information about who or where the instance is.
- A restart, container redeploy, or image rebuild does NOT change the ID (env var or settings row persists). This is the property that makes longitudinal per-instance views meaningful.

**Fleet-aggregate view (Option A).** All instances send under one synthetic site domain (`telemetry.example.com`). Every event still carries `props.instance = <hex>`, but Vince's dashboard does not expose custom-prop breakdowns, so the per-instance dimension is stored-only — queryable via raw Pebble export if forensic debugging is ever needed. The dashboard shows fleet-aggregate totals.

**HTTPS only — hard-fail at startup.** If `TELEMETRY_ENABLED=true` and `TELEMETRY_ENDPOINT` is missing or doesn't start with `https://`, the server refuses to start with a clear error. No plaintext telemetry ever, even on private networks.

**Deployment event deduped across restarts.** A crashlooping container would otherwise emit a `deployment` event every few seconds. The reporter persists `telemetry_last_deployment_event_unix` and `telemetry_last_deployment_event_version` in the `settings` table and emits at most one `deployment` event per (version, 24h window) per instance.

**Schema version on every event.** All events carry `props.schema = "1"`. When event shapes change, the version bumps so the maintainer can filter "events from v1.5+" cleanly.

## Vince / Plausible Event Contract

Every event sent from a reporter becomes one POST to `${TELEMETRY_ENDPOINT}/api/event`:

```http
POST /api/event
Content-Type: application/json
User-Agent: medtracker/1.42.0

{
  "name": "pageview",
  "url": "https://telemetry.example.com/screen/bp",
  "domain": "telemetry.example.com",
  "props": {
    "instance": "a1b2c3d4e5f60718",
    "schema": "1",
    "screen": "bp"
  }
}
```

Field mapping:

| Field | Value | Rationale |
|-------|-------|-----------|
| `domain` | fixed `telemetry.example.com` | One Vince site for the whole fleet. The site must be registered in the maintainer's Vince admin first (verified empirically: unregistered domains return `202` + `x-plausible-dropped: 1` and silently disappear). |
| `url` | synthetic, path-shaped — see table below | Plausible/Vince's "Top Pages" view groups by URL path. We construct path-shaped synthetic URLs so the dashboard is immediately useful with no per-event Goal configuration. Never includes data from the operator's real request URL. |
| `name` | event-name allowlist — see [event-name allocation](#event-name-allocation) below | Closed set; reporter rejects unknown names before sending. |
| `User-Agent` | fixed `medtracker/<version>` | The operator's browser/OS UA never reaches Vince. |
| `X-Forwarded-For` | **not sent** (Option A) | The original design synthesized an XFF to give Vince per-instance unique-visitor hashing. Since Vince's UI doesn't expose per-instance breakdowns, the trick provided no dashboard value and is dropped. The Go server's outbound IP reaches Vince, which is fine — that IP belongs to the operator's own infra and never appears on the maintainer's dashboard as identifying. |

### Event-name allocation

Vince's "Top Pages" view is the prominent default panel and groups events whose `name` is `pageview` by their `url` path. Custom-named events surface in a secondary "Top events" panel and typically require Goal configuration to be charted. We allocate event names so the most-asked maintainer question ("which screens are operators opening?") lands in the prominent view without any Vince-side configuration:

| Event name | Type | URL pattern | Other props | Why this name |
|------------|------|-------------|-------------|---------------|
| `pageview` | Plausible-native | `https://telemetry.example.com/screen/<screen>` | `screen` | Browser screen navigations. Land in "Top Pages" → top screens are immediately visible. |
| `http_request` | custom | `https://telemetry.example.com/api/<method>/<route-with-dashes>` | `method`, `route`, `status` | Backend route counts. Custom event so they don't pollute "Top Pages" with `/api/...` entries; surfaceable as a Goal for an "API heatmap" panel. |
| `feature_used` | custom | `https://telemetry.example.com/feature/<action>` | `action` | Web/frontend writes. Distinct from `bot_action` to preserve the bot-vs-web split. |
| `bot_action` | custom | `https://telemetry.example.com/bot/<action>` | `action` | Telegram-bot-initiated writes. Distinct event name so bot vs web is comparable in the dashboard. |
| `mcp_call` | custom | `https://telemetry.example.com/mcp/<operation>` | `operation`, `status` | Registry operations invoked from `mcp_execute` Python scripts (proxy path). |
| `scheduler_action` | custom | `https://telemetry.example.com/scheduler/<action>` | `action` | Reminders / transitions fired by the scheduler. |
| `sse_event` | custom | `https://telemetry.example.com/sse/<kind>` | `kind` | SSE changes-stream lifecycle (`connect`, `disconnect`, `rst_stream`). |
| `deployment` | custom | `https://telemetry.example.com/deployment` | `version`, `go_version`, `os` | One per (version, 24h) per instance. Adoption curve. |

Every event additionally carries `props.instance` (the install-time hex) and `props.schema` (currently `"1"`). The reporter rejects events whose name isn't on this list and whose props contain keys outside the per-name allowlist.

### Setup on the Vince side

- Register `telemetry.example.com` as a site in Vince admin. Without this, Vince returns `202` but discards the event (`x-plausible-dropped: 1`).
- Configure each custom event name (`http_request`, `feature_used`, `bot_action`, `mcp_call`, `scheduler_action`, `sse_event`, `deployment`) as a Goal so it appears in the dashboard's "Top events" panel.
- Set Vince's retention to 2 years (matches the public commitment in [TELEMETRY.md](../TELEMETRY.md)).

## Opt-In Mechanism

```bash
# In the operator's .env or docker-compose environment:
TELEMETRY_ENABLED=true
TELEMETRY_ENDPOINT=https://telemetry.yourdomain.com
TELEMETRY_INSTANCE_ID=a1b2c3d4e5f60718   # set by installer; auto-generated if absent
# HTTPS_PROXY=...                         # standard Go env var, just works
```

| State | Behavior |
|-------|----------|
| `TELEMETRY_ENABLED` unset or `false` | Reporter is a no-op: zero allocations, zero goroutines, zero network calls. Frontend `telemetry.js` is not loaded. |
| `TELEMETRY_ENABLED=true`, no endpoint | Server refuses to start. Clear error. |
| `TELEMETRY_ENABLED=true`, endpoint is `http://...` | Server refuses to start. Clear error. |
| `TELEMETRY_ENABLED=true`, endpoint is `https://...` | Reporter initializes; first event resolves the instance ID (env → settings → generate+persist). |

The frontend module is only loaded when `/api/bootstrap` returns `telemetry_enabled: true`. Opted-out instances never download tracking JS.

## What Is Collected

### Server-side: HTTP middleware

Every HTTP request emits one `http_request` custom event with route pattern only — no parameters, no body:

| Event | Prop | Notes |
|-------|------|-------|
| `http_request` | `method` | `GET`, `POST`, etc. |
| `http_request` | `route` | Mux route pattern, e.g. `/api/bp` — never `r.URL.Path` (which would contain `/api/bp/42`). |
| `http_request` | `status` | `2xx`, `4xx`, `5xx`, **`0`**. Bucketed. The `0` bucket captures client cancellation / write timeout — important because the project's SSE stream sits behind Traefik with documented `RST_STREAM` quirks ([docs/sse-traefik.md](sse-traefik.md)). |

The middleware emits for **every** HTTP route, including the routes underlying bot-callback `POST`s and the `/api/telemetry/event` route itself (the latter would be infinite-loop dangerous if the reporter weren't a single async path — verified by `TestTelemetryHandlerDoesNotEmitForItself`).

### Server-side: Telegram bot

The bot is a primary surface for this app and is tracked **as its own dimension**, deliberately separate from the web/frontend `feature_used` events. The most interesting fleet question this design exists to answer is: *do operators prefer the bot or the web UI for each kind of action, and does that split change with version?* If `bot_action` and `feature_used` shared one event name, that split would be invisible.

**Emission lives at the transport layer**: bot callback handlers in `internal/bot/*_callbacks.go` emit `bot_action`; HTTP handlers in `internal/server/` emit `feature_used`. Domain services (`internal/domain/`) do **not** emit telemetry — they can't see the originating transport, so emission there would collapse the bot-vs-web split. This means the same domain operation (e.g. `medication.Confirm`) emits a different event name depending on which transport called it, which is exactly the signal we want.

To prevent double-counting via the HTTP middleware (which emits `http_request` for every HTTP route, including the routes underlying bot callbacks): the middleware's `http_request` event and the bot handler's `bot_action` event have different names and report different facts. `http_request` says "an HTTP route was hit at the transport level"; `bot_action` says "a user-meaningful action happened via the bot." They coexist without conflict.

| Event | Prop | Values |
|-------|------|--------|
| `bot_action` | `action` | `med_confirmed`, `med_skipped`, `bp_logged`, `weight_logged`, `workout_started`, `workout_completed`, `reminder_snoozed`, `reminder_blocked`, `food_logged`, `diary_note_created` |

No message text, no Telegram IDs, no chat IDs, no values.

### Server-side: scheduler

| Event | Prop | Values |
|-------|------|--------|
| `scheduler_action` | `action` | `med_reminder_fired`, `bp_reminder_fired`, `weight_reminder_fired`, `workout_reminder_fired`, `tz_transition_step_fired` |

Low-volume, high-signal for understanding scheduler health and adoption.

### Server-side: MCP executor

The project's `mcp_execute` tool runs operator-authored (or AI-authored) Python scripts inside a sandbox that call back into the Go server via the in-process proxy → bridge → operation registry path (see [docs/mcp-coverage.md](mcp-coverage.md) and [docs/mcp-python-executor.md](mcp-python-executor.md)). Those calls don't traverse the normal HTTP mux, so the standard request-counting middleware would miss them.

The executor emits `mcp_call` once per registry-operation invocation. The op slug is already a closed allowlist (it's the same registry the MCP coverage guard test enforces), so there's no risk of unbounded prop cardinality.

| Event | Prop | Values |
|-------|------|--------|
| `mcp_call` | `operation` | Registry operation slug, e.g. `bp.create`, `medication.list`, `food.log`, `workout.session.start` — the closed set from `internal/mcp/registry/operations_*.go` |
| `mcp_call` | `status` | `2xx`, `4xx`, `5xx` |

This answers "which backend capabilities does the AI / Python scripts actually exercise?" — high-signal because it shows what the operator's workflows look like inside scripts, which the HTTP middleware view alone can't see.

### Server-side: SSE changes stream

The existing SSE channel ([docs/technical-decisions.md](technical-decisions.md)) is server→client only and is **not** reused as transport for telemetry events (telemetry flows client→server→Vince — wrong direction; see [SSE Relationship](#sse-relationship)). What we *do* track is SSE connection lifecycle as a signal — it tells us about online/offline patterns and reverse-proxy quirks.

| Event | Prop | Values |
|-------|------|--------|
| `sse_event` | `kind` | `connect`, `disconnect`, `rst_stream` |

No durations, no client IPs, no stream IDs.

### Client-side: frontend

**Screen views** — emitted as Plausible-native `pageview` events on navigation via `navigator.sendBeacon`, so they land in Vince's prominent "Top Pages" view without per-event Goal configuration:

| Event | URL | Prop | Values |
|-------|-----|------|--------|
| `pageview` | `https://telemetry.example.com/screen/<screen>` | `screen` | `today`, `bp`, `food`, `meds`, `health`, `workouts`, `weight`, `settings` |

**Feature actions** — sent on user-initiated writes as a custom event so they don't pollute the screen-views view:

| Event | Prop | Values |
|-------|------|--------|
| `feature_used` | `action` | `bp_logged`, `weight_logged`, `med_confirmed`, `med_skipped`, `food_manual`, `food_photo`, `food_barcode`, `workout_started`, `workout_completed`, `diary_note_created` |

No values, no counts, no content. Just "a BP reading was logged." The service worker does NOT independently emit telemetry — all client-side emission happens on the main thread.

### Startup: deployment event (deduped)

| Event | Props |
|-------|-------|
| `deployment` | `version`, `go_version`, `os` |

Fired at most once per (version, 24h window) per instance. Crashloop-safe. This gives the version adoption curve — critical for knowing when a migration or API change has saturated the fleet.

## What Is NEVER Collected

Enforced by design (the telemetry package has no access to these) and by audit:

| Category | Examples |
|----------|----------|
| **Personal identity** | User IDs, Telegram IDs, email addresses, names |
| **Instance identity** | Domain names, hostnames, public IPs, TLS certificates |
| **Health data** | BP values, weight values, medication names/dosages, food names, sleep durations, workout details, diary content |
| **Precise timestamps** | Exact event times; Vince sees hour-of-day aggregates only |
| **Request content** | Request bodies, query parameters, headers, `User-Agent`, `Referer` |
| **Dataset metadata** | Counts of medications, BP readings, food logs — anything that reveals the size of the operator's dataset |
| **Error content** | Error messages, stack traces (only route-level status buckets are sent) |

## SSE Relationship

The project already has an SSE changes stream from server to client. Two questions worth addressing explicitly:

**Why not reuse SSE as telemetry transport?** Telemetry events flow client → server → Vince. SSE is server → client only, so it's the wrong direction. Client-side events use `navigator.sendBeacon` because:

- It's one-shot and fire-and-forget — no persistent connection required.
- It works during page unload (the SSE connection is being torn down at that moment).
- It avoids coupling telemetry to the SSE reconnect/retry logic.

If a future use case needs server-to-client telemetry coordination (e.g., dynamic sample-rate hints), the existing SSE channel can carry a typed message — but that's not in v1.

**SSE as a telemetry source.** The connection lifecycle is itself a useful signal (`sse_event`, above).

## MCP Coverage Policy

The new `POST /api/telemetry/event` route must be either registered in `internal/mcp/registry/` or listed in `internal/server/mcp_coverage_exempt.go` with a `Reason`. Telemetry intake is not a user-actionable backend capability that `mcp_execute` Python scripts should call, so the exempt path is correct:

```go
// internal/server/mcp_coverage_exempt.go
"POST /api/telemetry/event": {
    Reason: "Telemetry intake; no user-actionable semantics; never readable by MCP.",
},
```

Without this entry, `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` fails CI ([docs/mcp-coverage.md](mcp-coverage.md)).

## Re-identification Risk at Small Fleet Size

At small N (say, the first 5 reporting instances), the combination of `version + go_version + os + hour-of-day pattern + instance prop` is uniquely identifying *to the maintainer*. This is a stated, accepted tradeoff: the operator and the maintainer have a known relationship (the operator chose to send telemetry to the maintainer's server). The goal is to characterize fleet behavior, not to anonymize the operator from the maintainer.

Operators who want stronger anonymity can keep `TELEMETRY_ENABLED=false`.

## Implementation Plan

### New Go packages

```
internal/
├── telemetry/
│   ├── reporter.go       # Reporter struct, buffer, flush loop, Vince client
│   └── reporter_test.go
└── server/
    ├── telemetry_handler.go   # POST /api/telemetry/event
    └── telemetry_middleware.go # Route-level request counting
```

### `internal/telemetry/reporter.go`

```go
package telemetry

type Event struct {
    Name  string
    Props map[string]string
}

type Reporter struct {
    client      *http.Client
    endpoint    string
    instanceID  string             // stable hex from env or settings; emitted as props.instance but forensic-only
    domain      string             // "telemetry.example.com"
    version     string
    buffer      chan Event         // depth 256, sends are non-blocking
    enabled     bool
    ctx         context.Context
    cancel      context.CancelFunc
    store       InstanceMetaStore  // for instance ID + deployment dedup
}

func NewReporter(cfg Config, store InstanceMetaStore) (*Reporter, error)
func (r *Reporter) Track(name string, props map[string]string)
func (r *Reporter) TrackDeployment(version, goVersion, osName string)  // idempotent within (version, 24h)
func (r *Reporter) Shutdown(ctx context.Context) error
```

Validations at `NewReporter`:

- `enabled && endpoint == ""` → error.
- `enabled && !strings.HasPrefix(endpoint, "https://")` → error.
- Instance ID resolution order: env var → `settings` table → generate-and-persist.

Runtime behaviors:

- `Track` uses a `select` with `default` — drops on full buffer, never blocks.
- Flush loop: every 5s or when buffer reaches 50 events.
- Sends events one-by-one to Vince's `POST /api/event`.
- Always sets the synthetic UA (`medtracker/<version>`); always tags `props.instance` and `props.schema`. Does NOT set `X-Forwarded-For` (Option A — see [Backend Selection](#backend-selection-decided-option-a)).
- `Shutdown` drains remaining buffer with a context-bound timeout.

### Integration points

Emission happens at the **transport layer** (where the caller's identity is known), never in the domain service (which can't see the transport). This is what preserves the bot-vs-web split in the dashboard.

- `internal/server/telemetry_middleware.go` — wraps the mux, emits `http_request` with `{method, route, status}`. Route patterns come from the mux, not `r.URL.Path`.
- `internal/server/telemetry_handler.go` — `POST /api/telemetry/event` with allowlist validation. Returns `204` on success or when telemetry is disabled (indistinguishable to the client).
- `internal/server/*_handler.go` — HTTP write handlers call `telemetry.Track("feature_used", ...)` after a successful domain-service call. (Reads do not emit `feature_used`; they're already captured at the `http_request` level.)
- `internal/bot/*_callbacks.go` — bot callback handlers call `telemetry.Track("bot_action", ...)` after a successful domain-service call. Same set of `action` values as `feature_used`, deliberately a different event name so the split is visible.
- `internal/domain/*.go` — domain services do **not** emit telemetry. They can't see whether the caller is the bot or an HTTP handler, so emission there would collapse the split.
- `internal/scheduler/*.go` — call `telemetry.Track("scheduler_action", ...)` on each fire.
- `internal/mcp/executor/` — call `telemetry.Track("mcp_call", ...)` once per registry-operation invocation. The proxy is the natural hook point since every script call passes through it; emit there rather than at the bridge so the script-level view (rather than the HTTP-route-level view) is what gets counted. Note that the underlying HTTP call via the bridge also emits `http_request` at the middleware — that's fine, the two events report different facts (script-level operation vs HTTP-level route).
- `internal/server/sse.go` (wherever the changes-stream lives) — call `Track("sse_event", ...)` on connect/disconnect/RST.
- `cmd/bot/main.go` — wire reporter into `store.Repos`, bot, scheduler, and HTTP server.

### Frontend (`web/static/js/features/telemetry.js`)

```js
// Only loaded when bootstrap.telemetry_enabled === true.
window.trackScreenView = (screen) => {
  navigator.sendBeacon('/api/telemetry/event', JSON.stringify({
    name: 'pageview',                      // Plausible-native; lands in "Top Pages"
    url: `/screen/${screen}`,              // server rewrites to full synthetic URL
    props: { screen },
  }));
};

window.trackFeatureUsed = (action) => {
  navigator.sendBeacon('/api/telemetry/event', JSON.stringify({
    name: 'feature_used',                  // custom event
    props: { action },
  }));
};
```

Callers must defensively check `if (window.trackScreenView)` since the module is absent when telemetry is off. The service worker does not import this module.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEMETRY_ENABLED` | No | `false` | Enable fleet telemetry reporting. |
| `TELEMETRY_ENDPOINT` | Only if enabled | — | HTTPS URL of central Vince instance. Hard-fail if not `https://`. |
| `TELEMETRY_INSTANCE_ID` | No | auto | Stable hex ID. Set by installer; falls back to lazy-persisted generation in `settings`. |
| `HTTPS_PROXY` | No | — | Standard Go HTTP-client proxy var; works for operators behind corporate proxies. |

### Installer changes

[docs/installer.md](installer.md) — at install time, generate `TELEMETRY_INSTANCE_ID=$(openssl rand -hex 8)` and write it to the operator's `.env`. Do **not** flip `TELEMETRY_ENABLED=true` for them — opt-in stays implicit. The ID is just provisioned so it's stable if the operator later opts in.

### Mandatory tests

| Test | Asserts |
|------|---------|
| `TestReporterIsNoOpWhenDisabled` | Zero outbound HTTP calls when `enabled=false`. Regression guard against accidentally bypassing the gate. |
| `TestReporterRefusesPlaintextEndpoint` | `NewReporter` errors on `http://...`. |
| `TestReporterRefusesMissingEndpoint` | `NewReporter` errors when enabled and endpoint is empty. |
| `TestInstanceIDPersistedAcrossRestart` | First reporter generates ID, second reporter reads the same ID from settings. |
| `TestDeploymentEventDedupedWithinDay` | Two `TrackDeployment` calls with same version and timestamp within 24h emit only one event. |
| `TestOutboundHeadersStripped` | Outbound request to Vince does not include any `Referer`, real browser `User-Agent`, real client IP, or any header from the originating request other than the synthetic UA. |
| `TestNoXForwardedFor` | Outbound request to Vince has no `X-Forwarded-For` header (Option A — we deliberately don't set one). |
| `TestEventPropsAllowlistEnforced` | Handler rejects unknown event names and unknown prop keys. |
| `TestEmissionAtTransportLayer` | A call to a domain service from a bot test path emits `bot_action`; the same domain service called from an HTTP test path emits `feature_used`. Domain service itself emits nothing. Regression guard against accidentally moving emission into the domain layer. |
| `TestTelemetryHandlerDoesNotEmitForItself` | The middleware's `http_request` event is NOT emitted for `POST /api/telemetry/event` itself (would be a feedback loop). |

### Vince setup

Single binary on the maintainer's central server:

```bash
vince admin --name admin --password <strong-password>
vince serve --port 8080
```

Behind a reverse proxy with TLS. Password-protect the dashboard. No multi-tenancy needed — all instances report under one synthetic site domain (`telemetry.example.com`). **Register that site explicitly in Vince's admin** — Plausible-compatible servers return `202` but discard events whose `domain` isn't on the configured sites list (verified empirically: response header `x-plausible-dropped: 1`).

**Configure Goals for each custom event name** (`http_request`, `feature_used`, `bot_action`, `mcp_call`, `scheduler_action`, `sse_event`, `deployment`) in Vince admin so they appear in the "Top events" panel — without this, Vince stores the events but doesn't surface them on the dashboard. `pageview` events (screen views) need no Goal; they appear in "Top Pages" automatically.

Configure Vince to not log Go-server outbound IPs to disk (or accept that they're logged — they're the maintainer's own infra IPs).

**Data retention: 2 years.** Vince's Pebble store retains forever by default; the maintainer commits to a 2-year TTL via Vince's retention setting (or a periodic prune job if Vince doesn't expose one). This is documented in the public [TELEMETRY.md](../TELEMETRY.md) so operators know what they're opting into.

### Estimated effort

| Task | Effort |
|------|--------|
| `internal/telemetry/reporter.go` + tests | ~200 lines (synthetic header derivation + dedup adds a bit) |
| `internal/server/telemetry_handler.go` + middleware | ~100 lines |
| Bot/scheduler/SSE emission hooks | ~30 lines across the call sites |
| Frontend `telemetry.js` + bootstrap integration | ~40 lines |
| Installer changes | ~10 lines |
| MCP coverage exempt entry + test fix | ~5 lines |
| `TELEMETRY.md` (user-facing) at repo root | ~50 lines |
| Vince deployment (separate server, maintainer side) | one Compose entry |
| **Total** | ~400 lines of Go + ~50 lines of JS |

## Privacy Guarantees (Auditable)

An operator can verify these guarantees by reading the code:

1. **No telemetry runs unless `TELEMETRY_ENABLED=true`.** The reporter is a no-op struct; the frontend module is never loaded.
2. **Endpoint must be HTTPS.** Validated at startup; plaintext is a hard error.
3. **Stable instance ID, random origin.** Generated via `crypto/rand` once at install (or lazily on first boot), never derived from anything identifying. Persists across restarts so per-instance views are meaningful — but contains no information about the operator.
4. **No domain or browser-side identifier leaves.** The browser talks only to the local Go server. Outbound requests to Vince carry a synthetic UA (`medtracker/<version>`) and a fixed synthetic domain. Vince sees the Go server's outbound IP, which is the operator's own server IP — fine, the maintainer's dashboard never displays it as identifying because all instances share the same site domain and there is no per-instance breakdown in the UI.
5. **No health data, no parameters, no bodies.** Events use fixed allowlists for names and props. The handler rejects unknown keys.
6. **Fire-and-forget with no persistence.** Events are held in a bounded in-memory channel. No disk queue. No retry. Buffer full or Vince unreachable → silent drop.
7. **Crashloop-safe.** Deployment events are deduped per (version, 24h); container restarts don't flood the dashboard or inflate fleet metrics.
8. **No service-worker telemetry.** Client-side emission is main-thread only.

## Backend Selection (Decided: Option A)

The design above assumes per-instance breakdown is dashboard-visible via Vince's custom-prop filtering. Empirical testing (60 events spread across 3 synthetic instances) revealed two findings that change the picture:

1. **Vince's ingestion honors `X-Forwarded-For`.** Source: `internal/web/db/event_request.go` reads from `[x-vince-ip, cf-connecting-ip, b-forwarded-for, X-Real-IP, X-Forwarded-For, X-Client-IP, Fly-Client-IP]` in priority order. Our synthetic per-instance IPs reach the unique-visitor hash correctly.
2. **Vince's UI does not support filtering or breakdown by custom event props.** `props.instance` is stored in Pebble but is not surfaced anywhere in the dashboard. The per-instance dimension — the design's load-bearing assumption — is unreachable from Vince's UI as-is.

Three options. Decision pending; data-collection implementation (allowlists, reporter, hooks) is backend-agnostic and can proceed without resolving this.

### Option A — Scale back to fleet-aggregate (keep Vince)

Accept that Vince is a fleet-wide aggregate tool. Drop the synthetic `X-Forwarded-For` trick. Demote `props.instance` to forensic-only (stored, queryable via raw Pebble export, not dashboard-visible).

**What you can answer from the dashboard:**

- Top screens / features / actions / MCP operations across the whole fleet
- Bot-vs-web split (the two event names — `bot_action` vs `feature_used` — remain distinct and are first-class in Vince's "Top events" view)
- Version distribution: count `deployment` events per `version` value
- Scheduler / SSE volume trends
- HTTP route heatmap across the fleet

**What you lose:**

- "Which specific instance is still on v1.41.3?" — answerable only via raw Pebble export grep
- Per-instance behavioral comparison (operator A's bot/web split vs operator B's)
- Per-instance debugging when a 5xx pattern is suspected to be localized

**Implementation diff vs current design:**

- Remove synthetic XFF generation from the reporter
- Remove `TestSyntheticHeadersNeverLeakRealIP` requirement (no synthetic XFF to test); keep the UA-stripping test
- Demote `props.instance` framing in TELEMETRY.md to "stored for forensic raw export; not visible on the dashboard"
- Decisions row #1 changes from "Yes, per-instance breakdown" to "No, fleet-aggregate only"
- Installer still provisions `TELEMETRY_INSTANCE_ID` (cheap; preserves option to upgrade later without re-IDing the fleet)

**Effort:** trivial — strip code that hasn't been written yet.

### Option B — Switch backend

Move to a tool whose UI does support per-property breakdown natively. Two realistic candidates:

| Tool | Pros | Cons |
|------|------|------|
| **PostHog (self-hosted, OSS)** | Generous free tier; rich per-property breakdowns, funnels, retention, feature flags; mature dashboard. | Heavyweight deployment (Postgres + ClickHouse + Kafka + Redis); ongoing operational burden. Privacy-permissive defaults that need explicit lockdown to match this design. |
| **Plausible CE (self-hosted, OSS)** | First-class custom-prop filtering and breakdowns; the UI Vince is trying to clone, done correctly. | Elixir + Postgres + ClickHouse stack; non-trivial to operate. License is AGPL — fine for self-host but worth knowing. |

**Implementation diff vs current design:**

- Vince setup section replaced with PostHog/Plausible setup
- Event contract section: PostHog and Plausible expect slightly different payload shapes. The reporter's `Track` API stays identical; only the HTTP marshalling layer changes.
- Synthetic XFF kept (PostHog and Plausible both honor per-event IP for unique-visitor and geo, and both expose per-property breakdown so the trick remains useful)
- TELEMETRY.md gains a paragraph naming the new backend and its retention setting

**Effort:** half a day to stand up the new backend and re-run the test batch. Reporter code unchanged.

### Option C — Build a thin custom dashboard against Vince's raw data

Keep Vince as the event sink. Bypass its UI by querying Pebble directly (or via Vince's export API) and rendering a small set of per-instance views with a ~150-line Go binary served behind the same reverse proxy as Vince.

**What this gets you:**

- Per-instance everything — the design as originally specified
- Full control over what charts exist and how breakdowns are pivoted
- Reuses Vince's storage and Plausible-compat ingest (no migration of in-flight events)

**Cost:**

- You become a dashboard maintainer. Every new breakdown view is more Go and HTML.
- Vince's storage layer is an internal API; nothing guarantees the schema is stable across Vince versions. A Vince upgrade can break your custom views.

**Effort:** a weekend for the first version; ongoing carry cost as Vince evolves.

### Decision: Option A for v1

Fleet-aggregate answers most of the questions in the problem statement (top screens, feature adoption, version curve, bot-vs-web split, scheduler health). The per-instance dimension was nice-to-have, not load-bearing — and the `instance` prop is still in the data for forensic use via raw Pebble export. Lowest friction; preserves an upgrade path to C (custom dashboard against Vince's raw data) later if the aggregate view turns out to be insufficient. B is off the table — operational burden of PostHog/Plausible CE outweighs the dashboard ergonomics gain at our scale.

Implementation consequences applied throughout this doc:

- No synthetic `X-Forwarded-For` — operator IPs are protected by the proxy architecture alone (Vince sees the Go server's outbound IP, not the browser's).
- `props.instance` is still emitted on every event but is documented as forensic-only (raw export, not dashboard).
- The installer still provisions `TELEMETRY_INSTANCE_ID` so the fleet doesn't need re-IDing on a future upgrade to Option C.
- Event-name allocation tuned so Vince's default "Top Pages" view is immediately useful — see [Vince Event Contract](#vince--plausible-event-contract).

## Decisions

Previously open questions, resolved:

| # | Question | Decision |
|---|----------|----------|
| 1 | Per-instance breakdown? | **No — fleet-aggregate only (Option A).** `props.instance` is still emitted on every event but is forensic-only (raw Pebble export), not dashboard-visible. Persistent install-time ID preserves the upgrade path to a custom dashboard (Option C) later without re-IDing the fleet. |
| 2 | Scheduler events? | **Yes.** `scheduler_action` — low-volume, high-signal. |
| 3 | Bot-side events? | **Yes.** `bot_action`, tracked as a distinct dimension from `feature_used` so bot-vs-web split is visible per instance. |
| 4 | MCP executor coverage? | **Yes.** `mcp_call` with `operation` from the registry allowlist; emitted from the proxy so we see what AI/Python scripts actually invoke (HTTP middleware misses this path). |
| 5 | Maintainer weekly digest? | **Out of scope v1.** Revisit after the fleet has data. |
| 6 | `TELEMETRY.md` location? | **Repo root.** Most discoverable for self-hosters evaluating the project. Public; clearly states "opt-in only." |
| 7 | HTTPS-only? | **Yes.** Hard-fail at startup. |
| 8 | SSE as transport? | **No.** Wrong direction (server→client); telemetry uses `sendBeacon`. SSE connection lifecycle IS tracked as a signal. |
| 9 | GDPR posture? | Single-user self-hosted: the operator is the data subject and the data controller; consent via env var is sufficient. |
| 10 | Vince data retention? | **2 years.** Documented in public TELEMETRY.md as part of the opt-in contract. |

## References

- [Vince Analytics](https://github.com/vinceanalytics/vince) — self-hosted, single-binary, Plausible-compatible analytics
- [Plausible Events API](https://plausible.io/docs/events-api) — the API contract Vince implements
- [RFC 5737](https://datatracker.ietf.org/doc/html/rfc5737) — IPv4 documentation address ranges (used for synthetic X-Forwarded-For)
- [CLAUDE.md](../CLAUDE.md) — project rules and patterns this design follows
- [docs/architecture.md](architecture.md) — domain service pattern, store layer conventions
- [docs/mcp-coverage.md](mcp-coverage.md) — route coverage policy this design must satisfy
- [docs/sse-traefik.md](sse-traefik.md) — SSE behavior behind Traefik (motivates `sse_event` + status bucket `0`)
