# C2c: Cloud-Mode Food — Logs, Products, Search, and Direct-from-Browser AI

## Overview

Third C2 slice (after C2a; independent of C2b — different files, either
order works). Ports the food domain to the C1 pattern and makes the first
**external provider calls go directly from the browser**, keyed from the
vault's `integrations` record (shipped in C2a):

1. **Food logs + products + stats + meals** — vault records + ported macro
   math (the easy 60%).
2. **AI parsing (text + photo) client-side** — the OpenAI(-compatible)
   call moves from server to browser: same prompts, same strict JSON
   schema, same `CalculateMacros` normalization, keys read unmasked from
   the vault, never routed through any `/api` surface.
3. **Food-DB search direct** — FastFoodDB-shaped API with `X-API-Key`,
   pointed at the **operator-hosted default instance silently**
   (cloud-mode.md: "the exception to bring-your-own"), overridable in
   Settings → Integrations.

Two structural findings from discovery that shape this plan:

- **Four frontend paths bypass the shim seam** (raw `fetch`, not
  `apiCall`): photo multipart, description AI, streaming NDJSON product
  search, and the AI-undo delete. Each gets a `__MEDTRACKER_CLOUD__` guard
  branch; the bot-mode path stays byte-identical (rule: guard-only edits
  to `web/static`).
- **`food_intake_enabled` has no cloud analog.** Server-side it only gates
  the two AI handlers; in cloud mode it collapses to "is an OpenAI key
  present in the vault" — AI buttons render a "add a key in Settings →
  Integrations" hint when absent.

## Context (from discovery — port sources)

- **Route surface** (`internal/server/food_handlers.go`): log CRUD
  (`POST/PUT/GET/DELETE /api/food/log[...]`, GET grouped response with
  `days` default 1), `GET /api/food/stats` (`days` default 7, plain SUM),
  products CRUD (`GET` limit≤100 + `sort=usage|last_used|name`,
  `PUT/DELETE /{id}`), `GET /api/food/products/search?q=&remote=`
  (**NDJSON stream**: local array line first, then merged remote line;
  barcode = ≥8 all-digit chars), `POST /api/food/products/from-logs`,
  AI: `POST /api/food/log/from-photo` (multipart, field `image`, 8 MB cap)
  + `POST /api/food/log/from-description` (JSON, 4096-byte cap), both →
  `{status:"created", items:[...], failed}` — **server auto-creates logs,
  no confirmation step**; the frontend's undo toast is the safety net.
  Targets already live via C2a (`foodtargets` record).
- **Data model** (`internal/store/food/repo.go`): `food_log` rows store
  frozen **total** int macros + `eaten_at` UTC-normalized + nullable
  `product_id`; `food_products` store **per-100g** floats + `usage_count`
  + `is_meal` + `total_weight_g`, unique per `(user, name)`;
  `UpsertProduct` ON CONFLICT bumps usage, refreshes `last_used_at`,
  COALESCE-preserves non-zero macros. Manual log with a name also
  upserts a product (`food_handlers.go:83-113`) — the autocomplete cache.
  `is_meal` on a log is JOINed from the product, not stored.
- **Logic to port**: `CalculateMacros` (`internal/domain/food.go:11`) —
  `total = per100*weight/100` int-truncated, **calories recomputed as
  `4*carbs + 4*protein + 9*fat`**, never trusted from input;
  `groupFoodLogs` (`food_handlers.go:625`) — meal name by hour (Breakfast
  5-11 / Lunch 11-16 / Dinner 16-22 / else Snack), 30-min proximity
  clusters same-day, calendar-date groups multi-day; stats = straight
  window SUM over tz-midnight-aligned days (no per-day averaging).
- **AI contract** (`internal/ai/openai.go`): POST `{url}/chat/completions`
  Bearer key, model default `gpt-4o-mini`, `temperature:0.1`,
  `response_format: json_schema` strict with `mealSchema` →
  `{items:[{name, weight_grams, carbs_100g, protein_100g, fat_100g}]}`;
  fallback retry without response_format + JSON-shape instruction; fence
  stripping. Photo: data-URL in `content:[{text},{image_url}]`, own
  system prompt, vision key/url/model fall back to text-provider values.
  **`MealSystemPrompt` / `MealPhotoSystemPrompt` / `mealSchema` are the
  load-bearing constants to copy verbatim.**
- **Food-DB contract** (`internal/store/food/openfoodfacts_api.go`):
  `GET {base}/api/v1/food/search?q=&limit=20`, barcode
  `GET {base}/api/v1/food/barcode/{code}`, header **`X-API-Key`** (not
  Bearer), response `{barcode, name, kcal100g, protein, fat, carbs}` →
  per-100g product shape.
- **Keys** (C2a, `web/domain/settings.js`): `integrations` singleton —
  `openai.{api_key,url,model,vision_api_key,vision_url,vision_model}`,
  `food.{api_key,url,domain}`, masked-read (`'***'`) via
  `getIntegrations`; the **unmasked** internal reader
  (`getStoredIntegrations`, settings.js:152) is not exported yet.
- **Bypass call sites**: `features/food/photo.js:234-258` (FormData raw
  fetch), `log.js:673` (description raw fetch), `products.js:222-514`
  (NDJSON raw fetch + AbortController + `remote=true` load-more),
  `ai-undo.js:34` (raw DELETE).

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - contract mechanism (C1 pattern): existing food Vitest suites under the shim harness; provider HTTP faked at the fetch boundary
- Complete each task fully before moving to the next; small focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- **CRITICAL: bot-mode must not regress.** No `internal/server`/`internal/store`/
  `internal/domain` changes; `web/static` edits are `__MEDTRACKER_CLOUD__`
  guard branches only (bot path byte-identical); `internal/cloudserver` may
  change only for the default-food-DB injection (Task 5); `pnpm test` +
  `go test ./...` (both tags) green after every task.
- **CRITICAL: unmasked provider keys never cross the `/api` shim surface.**
  Sibling domains read them module-to-module; every shim route keeps
  returning masked shapes.

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: shim-mode runs of the food feature suites
  (manual log add/edit/delete + grouping render, stats week strip,
  products list/edit/delete, meal-from-logs, search local+remote with a
  faked food-DB fetch, description-AI and photo-AI flows with a faked
  provider fetch incl. the undo toast path, missing-key hint state).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Food domain core — `web/domain/food.js`

- [x] `createFoodDomain({records, now, timeZone, foodDb})` (`foodDb` =
      injected remote-search port; Task 5 provides the browser impl,
      tests inject a fake)
- [x] record types: `foodlog` (server field names, frozen total macros,
      `eaten_at` normalized like the server) and `foodproduct` (per-100g
      floats, `usage_count`, `is_meal`, `total_weight_g`; name-keyed
      upsert semantics incl. COALESCE-preserve + usage bump + last_used)
- [x] log create/update replicate the server's side effects: product
      upsert from named manual logs, ownership-by-construction, `is_meal`
      resolved from the referenced product at read time
- [x] port `CalculateMacros` (int truncation + 4/4/9 calorie recompute),
      `groupFoodLogs` (hour buckets, 30-min clusters, multi-day calendar
      grouping, group totals) and window-SUM stats with tz-midnight
      alignment (device tz — same accepted deviation as C1)
- [x] products list with limit/offset/sort + `is_meal` filter + `q`;
      `createMealFromLogs` aggregation (summed totals → per-100g,
      `total_weight_g` = sum)

### Task 2: Shim routes + feature flip

- [x] route table: log CRUD + stats + products CRUD + from-logs; delete
      the obsolete stubs; add `food` to `PORTED_SET` and default the
      feature flag per bot-mode behavior (nav tab appears)
- [x] search route: served by the shim as a plain JSON response for
      `apiCall`-shaped callers IF any exist — the NDJSON streaming caller
      is handled by the Task 4 guard instead; unknown-route warn list must
      be food-free after this plan

### Task 3: Client-side AI — `web/domain/foodai.js` + browser provider client

- [x] copy `MealSystemPrompt`, `MealPhotoSystemPrompt`, and `mealSchema`
      verbatim into `web/domain/foodai.js` with a comment pinning the Go
      source (`internal/ai/openai.go`); port `convertParsedMeal`
      validation (name non-empty, weight>0, macros≥0) + `CalculateMacros`
      application; parse → create log records → return
      `{status:"created", items, failed}` exactly like the handlers
- [x] `createFoodAIDomain({aiClient, foodDomain, now})` — pure; the
      browser `aiClient` lives in `web/cloud/js/aiclient.js`: chat
      completions with strict json_schema + the response_format-rejection
      fallback + fence stripping; photo path converts the picked File to
      a data URL (8 MB cap, image/* sniff) and sends the two-part content
      array; vision credentials fall back to text credentials
- [x] unmasked key access: export a narrowly-named reader from the
      settings domain (e.g. `readIntegrationsUnmasked`) consumed
      module-to-module by `aiclient.js`/`foodDb` ONLY — never reachable
      via any shim route (masked `getIntegrations` stays the only `/api`
      shape); grep-test in the contract suite asserts no route returns a
      raw key (grep-test lands in Task 6's contract-suite pass)
- [x] missing-key behavior: AI entry points return the "add a key in
      Settings → Integrations" error the UI can show; no key = no
      provider call attempted (this replaces `food_intake_enabled`)

### Task 4: Frontend bypass guards (guard-only, 4 sites)

- [x] `features/food/photo.js`: `__MEDTRACKER_CLOUD__` branch skips the
      FormData POST and hands the File to the cloud AI module (exposed via
      one new allowlisted `window.*` entry); same undo-toast + optimistic
      cache path afterwards
- [x] `features/food/log.js` description flow: cloud branch calls the
      cloud AI module instead of raw fetch; identical response handling
- [x] `features/food/products.js` search: cloud branch replaces the NDJSON
      stream with two-phase delivery (local results immediately, remote
      results when the food-DB fetch lands) feeding the same render
      callbacks + AbortController semantics
- [x] `features/food/ai-undo.js`: cloud branch routes the DELETE through
      `apiCall` (hits the shim); bot branch keeps its raw fetch untouched
- [x] new `window.*` globals get `tests/architecture.globals.test.js`
      allowlist entries with justification

### Task 5: Food-DB direct + operator default

- [x] browser `foodDb` port impl (`web/cloud/js/fooddb.js`): search +
      barcode GETs with `X-API-Key` from vault `integrations.food.api_key`
      (may be empty), response mapped per `openfoodfacts_api.go`; base URL
      = vault `integrations.food.url` when set, else the **operator
      default**
- [x] operator default plumbing: `CLOUD_FOOD_DB_URL` env on `cmd/cloud`,
      injected into the served page (the `cloud-boot.js` config path) —
      a URL, not a secret; absent env = remote search silently disabled
      (local-only results), never an error
- [x] Settings → Integrations: food URL field shows the effective default
      as placeholder (visible-but-unadvertised override, per
      cloud-mode.md) — no wizard step, no nagging
- [x] ⚠️ deployment requirement, verify on the rig: the operator food-DB
      instance must allow CORS from `*.<base>` origins — document the
      needed header/Traefik label in `docs/cloud-deployment.md`; if the
      operator instance can't do CORS, remote search stays local-only and
      this task documents why (do NOT proxy queries through the cloud
      server silently — that would move query-term exposure from "food-DB
      host" to "cloud operator" without consent) — documented in
      `docs/cloud-deployment.md`'s new "Food-DB CORS requirement" section;
      actual on-the-rig verification against a real FastFoodDB deployment
      is a manual step (skipped here - not automatable in this environment)

### Task 6: Shim-mode contract runs

- [ ] food log suite: add/edit/delete, grouping (hour buckets + 30-min
      cluster), stats strip vs targets, per-100g edit semantics (project
      memory: edit modals must show original per-100g values)
- [ ] products suite: list/sort/edit/delete, meal-from-logs, search
      local+remote (fake foodDb), barcode query detection
- [ ] AI suites: description + photo happy path (fake provider returning
      schema-shaped JSON → logs created → undo removes them), fallback
      path (provider rejects response_format), missing-key hint, oversized
      photo rejection
- [ ] masked-key assertion: `/api/settings/integrations` GET still returns
      `'***'`; no shim route response contains a stored raw key

### Task 7: Verify acceptance criteria

- [ ] full food UX works in the shim harness incl. all four guarded
      bypass paths; unknown-route warn list contains no `/api/food/*`
- [ ] `pnpm test` fully green; `go build ./... && go build -tags mobile
      ./...` + `go test -count=1 ./...` green; linters clean

### Task 8: [Final] Update documentation

- [ ] `docs/cloud-mode.md`: C2c implementation notes (record types
      `foodlog`/`foodproduct`, AI/foodDb ports, the four guarded bypasses,
      `food_intake_enabled` → key-presence collapse); leakage table gains
      the explicit row: **meal descriptions + photos → the user's AI
      provider, directly from the client** (BYO consent), and confirms the
      existing food-DB row covers the operator default
- [ ] `docs/cloud-deployment.md`: `CLOUD_FOOD_DB_URL` + the CORS
      requirement for the operator food-DB instance
- [ ] `CLAUDE.md`: cloud index row update if needed

## Technical Details

- **Why prompts are copied, not codegen'd**: two constants and one schema;
  a codegen pipeline for three literals is machinery. The pinning comment
  names the Go source; drift shows up as contract-suite divergence in
  parsed shapes. (`ponytail:` revisit if the prompt set grows.)
- **Auto-create + undo, unchanged**: cloud keeps the server's
  no-confirmation model — AI items become records immediately, the
  existing undo toast deletes them. Same UX, same risk profile.
- **NDJSON search has no shim equivalent by design**: streaming through
  `offlineAwareApiCall` would mean inventing a fake streaming contract;
  the guard branch delivering local-then-remote via the existing render
  callbacks is smaller and honest.
- **Photo memory pressure**: data-URL base64 of an 8 MB photo is ~11 MB
  in-tab — acceptable; no resize pipeline in this plan (`ponytail:` add
  client-side downscale if provider costs or mobile memory complain).
- **CORS reality check order**: OpenAI(-compatible) endpoints are
  CORS-open (documented in cloud-mode.md); the operator food-DB is the
  unknown — Task 5 verifies early and degrades to local-only.

## Post-Completion

*No checkboxes — informational.*

**Manual verification on the rig**: enter a real OpenAI key in
Integrations on device A; log "two eggs and toast" by text → items appear
with sane macros → undo one; photo-log a meal; scan a barcode with the
operator food-DB reachable; device B sees everything after pull; masked
key still reads `'***'` on both devices; `cloud admin inspect` shows only
`foodlog`/`foodproduct` tags and sizes.

**Deferred by design**: client-side image downscale; ElevenLabs voice
(own spike, see cloud-mode.md open questions); trial-pool relay (C5);
`food_intake_enabled` server toggle has no cloud surface.
