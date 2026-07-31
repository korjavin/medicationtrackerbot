# Technical Decisions

**Status:** normative. Standing decisions that still describe how the app
behaves today.

The two decisions that used to lead this file — *Why SSE is primary* and
*Source attribution via `X-Client-ID`* — moved to
[archive/sse-change-stream.md](archive/sse-change-stream.md). That mechanism
(`/api/changes/stream`, the `ChangeBroker` fan-out) exists only in the Go-server
code; **cloud mode has no change stream at all.**

## Why only three endpoints support offline writes

Adding offline write support requires: IndexedDB schema, optimistic UI rendering, conflict resolution on sync, and error handling for rejected writes. We limit this to the three most time-sensitive health actions (BP readings, weight logs, medication confirmations) where missing a data point is worse than the implementation complexity. Other writes (editing medications, creating workouts) are infrequent and can wait for connectivity.

## Why 5xx responses are treated as "offline"

When the app runs behind Traefik (or any reverse proxy), `navigator.onLine` stays `true` even when the backend Go process is down — the browser has a TCP connection to Traefik, just not to the app. HTTP 502/503/504 from the proxy are functionally identical to being offline, so the SW and sync layer treat them the same way: serve cached responses for reads, queue writes locally.

The frontend read-resilience helper `cachedFetch` (`web/static/js/cached-fetch.js`) inherits this policy via `isServerError` from `sync.js`: a 5xx falls through to the same cached-with-`isStale`-flag branch as a true offline read, and a missing cache raises `OfflineNoCacheError` for the consumer to render an explicit empty state. See [frontend.md → Local-First Read Resilience](frontend.md#local-first-read-resilience) for the full behaviour matrix and per-section freshness windows.

## Why IndexedDB is a write-ahead queue, not a full replica

After successful sync, records are deleted from IndexedDB rather than kept as "synced" copies. This keeps the local store small and avoids the complexity of bidirectional sync and conflict resolution. The SW cache and `api_cache` in IndexedDB already provide read-only offline access to previously fetched data.

## Why vanilla JS instead of a framework

The app is a privacy-first PWA with a large amount of client-side domain logic
and encrypted local state. A framework would add bundle size and build
complexity for little benefit. The cloud vault/oplog path and the legacy
four-layer local-first architecture (SW → IndexedDB → SyncManager → SWR
DataStore) are straightforward to implement with vanilla JS and Dexie.js.
