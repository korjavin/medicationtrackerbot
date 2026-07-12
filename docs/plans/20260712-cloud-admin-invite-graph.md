# Cloud admin `invite-graph` command

## Overview
- Add a new admin CLI subcommand `cloud admin invite-graph` that reconstructs and displays the invitation forest for the cloud deployment.
- Invite provenance is already stored: `accounts.created_by_account_id` (migration `010_invite_provenance.sql`) is the account that minted this account's invite; NULL = admin-CLI mint (a forest root). The who-invited-whom edges are therefore fully reconstructable, but there is no way to VIEW them today.
- Default output is an ASCII tree of the forest (roots = admin-minted, invitees nested recursively). `--format=dot` emits a Graphviz DOT digraph; `--format=json` emits nodes + edges JSON.
- Operator-only metadata (subdomains + provenance), NOT encrypted vault content. Admin CLI only — no HTTP endpoint, no new auth surface, no MCP-coverage impact. SESSION_SECRET not needed (plaintext accounts metadata, no sealed-token opening).

## Context (from discovery)
- Files/components involved:
  - `internal/cloudstore/repo.go` — add `ListAccountsForGraph` query + `AccountGraphNode` type. Mirror existing provenance queries (`CountAccountsCreatedBy`, `HasClaimedAccountCreatedBy`) which already read `created_by_account_id` and `claim_token_hash IS NULL`.
  - `cmd/cloud/admin.go` — add `invite-graph` case in `runAdmin`'s dispatch switch + usage line, mirroring `invite` / `migrate-bots-to-proxy` subcommand structure. The command opens its own `cloudstore.Repo` already (shared scaffolding).
  - `cmd/cloud/invite_graph.go` — NEW: pure forest builder + three renderers (ASCII / DOT / JSON) + the `adminInviteGraph` handler.
  - `cmd/cloud/invite_graph_test.go` — NEW: fixture-forest test for the builder + renderers, plus empty-DB case.
  - `docs/cloud-deployment.md` — document the command + `--format` in the admin section.
- Related patterns found:
  - `Account` struct + `CreateAccount(ctx, id, subdomain, claimTokenHash, claimExpiresAt, createdAt, vapidPub, vapidPriv, createdBy)` — the 8th arg `createdBy` ("" = NULL) lets tests build a fixture forest directly.
  - `AccountSummaries` / `AccountSummary` in `internal/cloudstore/inspect.go` — reference for a read-only list query + a small result struct.
  - `adminList` in `admin.go` — reference for a formatting-only admin handler using `tabwriter`.
  - Time helpers: `storedb.UnixToTime`, `storedb.TimeToUnix`. Claimed = `claim_token_hash IS NULL` (authoritative, matches `AccountSummary.Claimed`).
- Dependencies identified: `text/tabwriter` (already imported in admin.go), `encoding/json`, `strings`, `sort` (stdlib). No new external deps. Graphviz `dot` is the operator's tool for rendering DOT output — not a build dependency.

## Development Approach
- **Testing approach**: NO unit tests for trivial glue. ONE Go test file for the pure builder + renderers is the real guarantee here (the bead explicitly requires "a fixture forest → expected tree + edges", plus empty-DB). This test guards the tree/DFS/cycle-guard logic and the three output formats — a real boundary.
- Complete each task fully before moving to the next.
- Make small, focused changes; reuse existing admin scaffolding + store access.
- **CRITICAL: the builder/renderer test must pass before finishing.**
- No new migration (column already exists). No HTTP route, so no MCP-coverage changes.

## Testing Strategy
- **Unit tests**: none beyond the single builder/renderer test file below.
- **Integration tests**: the builder/renderer test in `cmd/cloud/invite_graph_test.go` exercises the pure logic over an in-DB fixture forest via `cloudstore` (real store query → builder → rendered strings). This is the boundary guarantee the bead asks for.
- **E2E tests**: none (no e2e suite for `cmd/cloud`).

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.

## What Goes Where
- Implementation Steps: store query, builder + renderers, subcommand wiring, the Go test, docs.
- Post-Completion: operator rendering DOT to SVG via `dot -Tsvg` (manual, informational).

## Implementation Steps

### Task 1: Add `ListAccountsForGraph` store query
- [ ] In `internal/cloudstore/repo.go`, add an `AccountGraphNode` struct: `ID string`, `Subdomain string`, `CreatedBy *string` (nil = admin-minted root), `CreatedAt time.Time`, `Claimed bool`.
- [ ] Add `func (r *Repo) ListAccountsForGraph(ctx context.Context) ([]AccountGraphNode, error)` running `SELECT id, subdomain, created_by_account_id, created_at_unix, claim_token_hash IS NULL FROM accounts ORDER BY created_at_unix, subdomain`.
- [ ] Scan `created_by_account_id` into a `sql.NullString` → map to `*string` (nil when NULL); scan `created_at_unix` via `storedb.UnixToTime`; scan the `IS NULL` boolean into `Claimed`.
- [ ] Add a doc comment noting NULL provenance = admin-CLI root and Claimed = claim token cleared (matches `AccountSummary.Claimed`).

### Task 2: Pure forest builder + three renderers in `cmd/cloud/invite_graph.go`
- [ ] Define a `forestNode` type (embeds/holds the `AccountGraphNode` + `Children []*forestNode`).
- [ ] `buildInviteForest(nodes []cloudstore.AccountGraphNode) (roots []*forestNode, orphans []*forestNode)`: map account ID → node; attach each node to its parent's `Children` when `CreatedBy` resolves to a present node; roots = `CreatedBy == nil`; orphans = `CreatedBy` set but points to a missing account (deleted inviter). Sort children deterministically (by CreatedAt then Subdomain).
- [ ] Guard cycles: during the tree walk keep a `visited` set keyed by node ID; never recurse into an already-visited node (defensive — provenance shouldn't cycle, but a self/loop reference must not infinite-loop). Render orphan subtrees under a clearly-labelled "orphaned (inviter deleted)" section so they are still visible.
- [ ] `renderTree(roots, orphans) string`: ASCII tree with `├──`/`└──`/`│  ` connectors; node label = `subdomain [claimed|pending] created=YYYY-MM-DD`. Empty forest → a `no accounts` line.
- [ ] `renderDOT(nodes []cloudstore.AccountGraphNode) string`: `digraph invites { ... }` — one node stmt per account (label = subdomain, `style=dashed`/distinct marker for pending), one edge `inviter -> invitee` per non-nil resolvable `CreatedBy`.
- [ ] `renderJSON(nodes []cloudstore.AccountGraphNode) ([]byte, error)`: `{ "nodes": [{id, subdomain, claimed, created_at}], "edges": [{from, to}] }` — edges only for resolvable inviters; stable ordering.

### Task 3: Wire the `invite-graph` subcommand into admin dispatch
- [ ] In `cmd/cloud/admin.go` `runAdmin` switch, add `case "invite-graph": return adminInviteGraph(ctx, store, args[1:])`.
- [ ] Add `adminInviteGraph(ctx, store, args)` (in `invite_graph.go`): parse an optional `--format=<tree|dot|json>` flag (default `tree`; unknown → stderr usage + exit 1); call `store.ListAccountsForGraph`; dispatch to the matching renderer; print to stdout; return 0. Use `log/slog` only if a real error path needs logging (prefer stderr + non-zero exit like sibling handlers).
- [ ] Add an `invite-graph` line to `printAdminUsage` describing the command + `--format=dot|json`.

### Task 4: Go test for the builder + renderers
- [ ] `cmd/cloud/invite_graph_test.go`: build a fixture forest via `cloudstore` in-memory (`storedb.Open(":memory:")` + `cloudstore.New`) using `CreateAccount` with explicit `createdBy` — two roots, nested invitees, at least one pending (unclaimed) invite, and one orphan (inviter id that was never created / deleted).
- [ ] Call `ListAccountsForGraph`, run `buildInviteForest`, assert root/orphan partition, parent→child edges, and cycle-guard (add a hand-built node whose `CreatedBy` points to itself → assert no infinite loop / it renders once).
- [ ] Assert `renderTree` output contains the expected subdomain labels with `[claimed]`/`[pending]` markers and nesting; assert `renderDOT` contains expected `a -> b` edges; assert `renderJSON` unmarshals to the expected nodes+edges counts.
- [ ] Empty-DB case: `ListAccountsForGraph` on a fresh store → `renderTree` prints the `no accounts` line, `renderJSON` has zero nodes/edges.

### Task 5: Verify acceptance criteria
- [ ] `go build ./... && go build -tags mobile ./...` both succeed.
- [ ] `TZ=UTC go test ./internal/cloudstore/... ./cmd/cloud/...` passes.
- [ ] Manually run `go run ./cmd/cloud admin invite-graph` (and `--format=dot`, `--format=json`) against a scratch DB to eyeball output shape (optional sanity; the test is the guarantee).

### Task 6: [Final] Document the command
- [ ] Add `cloud admin invite-graph` (+ `--format=dot|json`) to the admin section of `docs/cloud-deployment.md`: what it shows (invitation forest, claimed vs pending), the three formats, and the `dot -Tsvg` render hint.

## Technical Details
- `AccountGraphNode`: `{ ID, Subdomain string; CreatedBy *string; CreatedAt time.Time; Claimed bool }`.
- Roots = `CreatedBy == nil`. Orphans = `CreatedBy != nil` but not present in the ID map. Cycle guard = `visited` set during walk.
- Claimed = `claim_token_hash IS NULL`; pending = NOT NULL (outstanding invite).
- ASCII label: `<subdomain> [claimed|pending] created=<YYYY-MM-DD>`.
- DOT: `digraph invites { "sub" [label="sub", style=dashed for pending]; "inviterSub" -> "inviteeSub"; }` — use subdomains (unique) as node ids for a human-readable graph.
- JSON: `{"nodes":[{"id","subdomain","claimed","created_at"}],"edges":[{"from","to"}]}`.

## Post-Completion
**Manual verification** (informational, no checkbox):
- Operator renders the DOT output to an image: `cloud admin invite-graph --format=dot | dot -Tsvg > invites.svg`.
