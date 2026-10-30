# EMA Article 57 catalogue, schema v1

This proof of concept contains a contact-free projection of the European
Medicines Agency (EMA) Article 57 product register and a pure exact-name lookup.
It has no medication handler, editor, interaction, RxNorm or stored-record
integration. A result is a source candidate, not a verified clinical identity,
ingredient mapping, strength/formulation, substitution or safety assessment.

## Source and reuse

Source: European Medicines Agency (EMA), **Article 57 product data**,
EMA/518502/2018 Rev.90, data 9 October 2026, published 13 October 2026;
accessed October 2026. The [official dataset page](https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/data-medicines-iso-idmp-standards-post-authorisation/public-data-article-57-database)
links the [source workbook](https://www.ema.europa.eu/en/documents/other/article-57-product-data_en.xlsx).
The workbook's SHA-256 is pinned in `source.json`; its 7,892,500 bytes are
deliberately **not vendored**, because it includes pharmacovigilance contacts.

The [EMA legal notice](https://www.ema.europa.eu/en/about-us/about-website/legal-notice)
was checked on 30 October 2026. It permits reproduction/distribution for
commercial and non-commercial purposes with EMA acknowledged in every copy,
subject to its third-party material exceptions. The linked Article 57 page and
the selected workbook columns carry no additional reuse restriction identified
in this review. This is attribution-based reuse under that notice, not a claim
of an unrestricted or SPDX licence. Each generated catalogue carries the source,
reuse URL and attribution; the small real-row fixture carries attribution too.
Recheck the page, workbook notices and rights on each update. No EMA logo is used.

## Projection contract

`web/static/data/ema-article57-rev90-v1.json` is one compact JSON document:

```text
schema_version: 1
source: source.json (URL, revision, data/published dates, workbook SHA-256,
                     reuse URL/check date, attribution)
columns: ["name", "substances", "route", "jurisdiction"]
source_rows: count before exact four-column deduplication
rows: [[original A, original B, original C, original D], ...]
```

Only A-D are allowlisted: short product name, complete active-substance text,
route and exact product authorisation jurisdiction. Holder, master-file location,
email, telephone, workbook metadata, images and all other fields are excluded.
Strings retain original case, salts, punctuation, whitespace and route lists.
In column B, **`|` separates different pharmaceutical products**. Neither the
generator nor lookup decomposes it into ingredients or selects a component.

Identical four-column tuples are deduplicated. Distinct spelling/case, substance,
route and jurisdiction tuples remain separate, sorted lexicographically by UTF-8
bytes across A, B, C, D. There is no locale-dependent sort or generation timestamp.
The shared source envelope is provenance for every candidate. The release file
separately pins the generated asset hash, size and counts, avoiding a self-hash.

`createEMACatalogue(data)` in `web/domain/ema-catalogue.js` validates injected
schema-v1 data and snapshots a private name index. `exact(name, options)` uses
outer trim and Unicode `toLowerCase()` only, retaining every collision. This is
JavaScript lowercase, not Unicode full case folding; accents, internal spaces,
punctuation, salts and word order are never changed. Unknown or malformed input
returns an empty candidate array. No user data is written.

The result contains frozen `source`, `candidates` and `ambiguous` fields.
`ambiguous` means several distinct catalogue candidates survived; a single
candidate still carries opaque product/substance text and establishes no clinical
identity. An omitted jurisdiction returns all candidates. `jurisdiction` filters
by the exact source label; it never comes from locale/device/account. For example,
`{jurisdiction: 'Germany'}` includes Germany only; adding `includeEUWide: true`
also includes the literal `European Union` source rows. Selecting
`{jurisdiction: 'European Union'}` returns those rows only. No country membership
or authorisation equivalence is inferred.

## Reproduce and update

Download the workbook separately from the official URL to a temporary location;
do not add it to Git, logs or artifacts. From the repository root:

```sh
go run ./cmd/genemacatalog -src /path/to/article-57-product-data_en.xlsx
node scripts/measure-ema-catalogue.mjs
go test ./internal/emacatalog ./web/domain/
pnpm test web/static/js/tests/ema-catalogue.domain.test.js
```

The generator verifies the release lock hash before reading XML and checks its
revision/data date, required A-D headers, sheet layout and required values.
Missing/changed headers or malformed rows fail with row numbers, without printing
contact-bearing data. Two runs on the same pinned workbook yield identical sorted
bytes. An old release remains reproducible from a separately retained copy of its
pinned workbook; the mutable official URL is not an archival guarantee.

For an explicit update: inspect the new official release and reuse notices,
review/update `source.json`, regenerate to a temporary output first (`-out`),
inspect all projected columns and representative conflicts, then replace the
asset under a new release-specific filename (update the generator default,
measurement script and owning test path together). Run
`node scripts/measure-ema-catalogue.mjs --record` to record reviewed
hash/count/size changes; run it again without `--record` and run the owning tests.
A schema change requires a reviewed generator/schema update, never a permissive
fallback. Fixture tests are offline and build a small synthetic XLSX around
captured real A-D rows; synthetic excluded-column sentinels test the allowlist.

## Release evidence and packaging

`release.json` records 164,705 source rows, 161,194 distinct four-column tuples,
32 exact jurisdiction labels, 4,977 trimmed/lowercase names with distinct raw
substance strings and 1,081 tuples containing a product separator. Complete
independent comparison against the source A-D projection matched every tuple;
none of 6,488 distinct source email/telephone values equalled a projected value.
The validator also checks every row's schema, strict sorted uniqueness,
email-shaped text exclusion and real fixture membership. Cases include Candecor,
Smecta, cross-country Aacidexam, same-country Abnobaviscum Abietis, route-different
A 313, a multi-product pack and an atorvastatin case collision. These examples
demonstrate source retention, not clinical equivalence.

The final asset is **13,274,325 bytes JSON / 1,637,897 bytes gzip level 9**.
The previous 1,054,055-byte gzip observation omitted jurisdiction and route and
was only a lower-information baseline. One local Node 22 measurement read the
asset in 5.7 ms, parsed it in 152 ms and validated/built the index in 427 ms;
the script prints fresh timings. These are machine-specific synchronous costs,
not mobile-browser performance guarantees or network-load measurements.

A single sorted asset keeps the complete provenance/candidate set together.
Reviewed guards are 16 MiB JSON and 3 MiB gzip level 9: current content plus
bounded update headroom. Growth beyond either needs explicit packaging review.
The gzip size is a reproducible compression measurement, not a promise about
the server/proxy's negotiated transfer encoding. `web/static/embed.go` embeds
the JSON, increasing the cloud binary/container's raw assets by about 12.7 MiB.
The domain module is separately listed in its embed manifest.

No app import or load references this asset/module, so the existing PWA shell
graph does not precache it and ordinary medication use adds zero requests or
parse cost. A future consumer must explicitly load/cache the immutable release
and measure slower devices, memory and offline availability before integration.
There is no new shard egress or caching subsystem. Historical native shells are
frozen; any future packaging that copies this static tree would also inherit the
raw asset cost and needs its own measurement. Runtime integration and complete
ingredient-to-RxNorm mapping remain separate work (med-1p87).
