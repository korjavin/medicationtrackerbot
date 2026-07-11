# Vendored: `hasaneyldrm/exercises-dataset`

- **Upstream:** https://github.com/hasaneyldrm/exercises-dataset
- **Pinned commit:** `118e4bd6b14da6df0e36605d7169b65db18389a4`
- **Vendored file:** `exercises.json` (`data/exercises.json` upstream, 1,324 records)

Pinned and vendored (not fetched at runtime) because upstream is active and could
change field shapes. `cmd/genexercisecatalog` reads this file and regenerates the
trimmed, media-free static catalog at `web/static/data/exercises-catalog.json`.

## Licensing

Upstream is **NOASSERTION** (mixed license):

- **MIT** — code, data *structure*, and the **instruction text**. That is all we use.
- **Media** (`image`, `gif_url`, 180×180 thumbnails + GIFs) — © [Gym visual](https://gymvisual.com/),
  redistributed upstream *with permission* under a separate commercial license.

We vendor and ship **text metadata only**. No GIFs, no thumbnails, no `gif_url` /
`image` / `attribution` fields, no Gym-Visual media of any kind. See
`docs/research/2026-07-11-exercises-dataset.md`.
