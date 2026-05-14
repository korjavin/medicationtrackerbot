# Store Method-Naming Consistency Pass

## Status

Stub. Captured as a follow-up from `docs/plans/completed/2026-05-13-split-store-package.md`. Not yet scheduled.

## Overview

After the per-domain store split, each repo's method names are still a snapshot of the historical `*Store` god-object's vocabulary. The result is a grab-bag of synonyms across (and sometimes within) packages:

- `Create…` vs `Add…` for inserts (e.g. `medication.Repo.CreateMedication` but `medication.Repo.AddRestock`, `medication.Repo.AddIntakeReminder`).
- `Get…` vs `Fetch…` vs `Find…` vs `List…` for reads — the choice today reflects who wrote the method, not the semantics. `auth.Repo.FindAPITokenByHash` is the only `Find…`; the rest of the codebase uses `Get…` for single-row reads and `List…` for multi-row reads, with exceptions.
- Repo-package-qualified method names that re-state the domain redundantly (`medication.Repo.CreateMedication` reads as `medication.Repo.Create` would; `bp.Repo.GetBloodPressureReadings` reads as `bp.Repo.GetReadings`). The diary and push packages already shortened their public surface (`diary.Repo.Create` / `push.Repo.List`) during the split; the others didn't, to keep forwarder PRs reviewable.

## Goals

- One verb per operation across all repos: `Create` / `Get` / `List` / `Update` / `Delete` / `Set` / `Upsert` / `Import` / `Batch…`. Drop `Add`, `Fetch`, `Find`.
- Drop the domain redundancy where the package name already provides it. `medication.Repo.Create` instead of `medication.Repo.CreateMedication`. Keep the suffix only when a single repo owns multiple distinct entities (e.g. `medication.Repo.CreateIntake`, `medication.Repo.CreateRestock`, because those are siblings within the `medication` package).
- Resolve `Get…` vs `Fetch…` to `Get…` everywhere.
- Consistent pluralization: `Get` for single-row, `List` for multi-row. Today some readers (`GetExerciseLogs`, `GetIntakesSince`) return slices; rename to `List…`.

## Out of scope

- Domain types / column names.
- Renames inside `internal/store/migrations/` SQL files.
- Splitting any repo or moving methods between repos. Pure rename.
- Removing the `store.Store = store.Repos` alias.

## Approach

1. Cut a per-repo PR sequence (one PR per package, mirroring the original split order). Each PR is mechanical: `gopls rename` / `gorename` per symbol, plus the manual cleanups (`gopls` doesn't yet handle interface-satisfying renames across both consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` cleanly).
2. Update both consumer interfaces in the same PR as each repo rename — they are renamed together or not at all (CI catches mismatch).
3. Keep type-name aliases (`store.Medication = medication.Medication`) untouched; this pass is only about method names.
4. `go test ./...` + `go test -race ./...` + `golangci-lint run` green at every PR boundary.
5. No behaviour change. No SQL change. Diff dominated by mechanical renames.

## Risks

- **Adapter structs** in `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go` and `cmd/bot/tz_planner_adapter.go` define method names that satisfy *both* a consumer interface and forward to a repo. Renaming the repo method changes both sides; the adapter methods follow the consumer-interface name. Watch for: consumer interface kept under the old name (for callsite stability) while the underlying repo method is renamed — the adapter then needs an explicit one-line bridge instead of a same-name forward.
- **MCP registry operations** in `internal/mcp/registry/operations_*.go` reference store methods by string name in some places (operation handlers). Grep before each PR.
- **Test brittleness**: a handful of tests use reflect to assert method-name presence on adapters. The grep step above catches these.

## Estimate

About 1 day per repo for the larger ones (medication, workout) and 0.5 day each for the smaller ones — call it 6-8 days total spread across as many PRs.

## Open questions

- Should `Repo` itself shorten to package-name-driven types? `medication.Repo` is fine; `medication.Medication` is awkward. Possibly rename the latter to `medication.Record` or `medication.Entry`. Defer — out of scope for this pass; revisit only if a follow-up cleans up the type names too.
- Should the `Repos` aggregator (the field names like `s.Medication`, `s.BP`) align with `gofmt`'s preference for short receivers / short field names? Today the fields are short already. No action.
