// DataStore: unified client-side state access for API-backed resources.
// Provides:
// - Stale-while-revalidate loader
// - In-flight request deduplication per cache key
// - Tag-based cache invalidation
(function () {
    const inFlight = new Map();
    // Tracks a generation counter per cache key. Incremented when a key is
    // invalidated so that an abandoned in-flight request from before the
    // invalidation cannot re-cache stale data once it eventually resolves.
    const fetchGeneration = new Map();
    // Per-key count of outstanding applyOptimistic handles that have not yet
    // settled (commit/rollback). While > 0, the caller's own POST is in flight
    // and the optimistic state represents the post-mutation truth. fetchFresh
    // SHORT-CIRCUITS during this window so a concurrent GET (kicked off by a
    // post-optimistic reloadCurrentTab) cannot overwrite the optimistic cache
    // with the pre-write server state.
    const pendingOptimistic = new Map();
    const keyToTags = new Map();
    const tagToKeys = new Map();
    // tag → Set<prefix>. Lets `invalidateByTag(tag)` evict every concrete
    // dynamic key (`history_7_42`, `food_2026-05-14_day`, …) whose id starts
    // with one of the registered prefixes, without each call site having to
    // pre-enumerate the dynamic family.
    const tagFamilies = new Map();

    const hasValue = (value) => value !== null && value !== undefined;

    // Deep-clone a cache payload for the optimistic-rollback snapshot. Prefer
    // structuredClone when available (handles Date / Map / Set / TypedArrays),
    // fall back to JSON round-trip otherwise. Cache payloads are JSON-shaped in
    // practice so the fallback is safe.
    function deepCloneSnapshot(value) {
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* fall through */ }
        }
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function registerKeyTags(key, tags = []) {
        if (!key) return;

        // Remove old reverse links first to keep mapping consistent.
        const previousTags = keyToTags.get(key) || [];
        previousTags.forEach((tag) => {
            const keys = tagToKeys.get(tag);
            if (!keys) return;
            keys.delete(key);
            if (keys.size === 0) tagToKeys.delete(tag);
        });

        const normalized = [...new Set(tags.filter(Boolean))];
        keyToTags.set(key, normalized);
        normalized.forEach((tag) => {
            if (!tagToKeys.has(tag)) tagToKeys.set(tag, new Set());
            tagToKeys.get(tag).add(key);
        });
    }

    const DataStore = {
        async getCached(key) {
            if (!window.MedTrackerDB?.ApiCache) return null;
            return await window.MedTrackerDB.ApiCache.get(key);
        },

        async setCached(key, data) {
            if (!window.MedTrackerDB?.ApiCache) return;
            await window.MedTrackerDB.ApiCache.set(key, data);
        },

        // Register a key→tags mapping without touching the cached value. Use
        // this when a caller reads a cached payload directly from IndexedDB
        // (bypassing loadSWR/fetchFresh) but still wants future invalidateByTag
        // calls to evict the entry. Without it, `tagToKeys` is empty for that
        // key on cached-start / reload paths, so `invalidateTags(['food'])`
        // (etc.) silently no-ops and stale payloads survive mutations.
        registerTags(key, tags = []) {
            registerKeyTags(key, tags);
        },

        // Register a dynamic key-family prefix under `tag`. Every concrete
        // api_cache row whose id starts with `prefix` will be evicted when
        // `invalidateByTag(tag)` runs, even if the row was never seeded
        // through registerTags / fetchFresh (e.g. a `history_7_42` row that
        // came in via a one-off cachedFetch the user has never re-issued).
        // The CacheKeys registry calls this once at boot for every family
        // (`history_`, `food_`, `health_overview_`).
        registerTagFamily(prefix, tag) {
            if (typeof prefix !== 'string' || !prefix || !tag) return;
            if (!tagFamilies.has(tag)) tagFamilies.set(tag, new Set());
            tagFamilies.get(tag).add(prefix);
        },

        // Cache an authoritative value (e.g. from a bootstrap payload) and
        // register its tags. Bumps the key's generation and drops any pending
        // in-flight fetch for it so an older request — which may have been
        // issued before the server-side change that produced `data` — cannot
        // overwrite this value once it eventually resolves.
        async setCachedWithTags(key, data, tags = []) {
            registerKeyTags(key, tags);
            if (key) {
                fetchGeneration.set(key, (fetchGeneration.get(key) || 0) + 1);
                inFlight.delete(key);
            }
            await this.setCached(key, data);
        },

        // Optimistic write helper: synthesise the post-mutation cache state
        // BEFORE the network round-trip resolves, so the caller's screen can
        // repaint without waiting on the POST.
        //
        // Contract:
        //   - `key`: the cache key carrying the affected payload (e.g. `bp`,
        //     `food_<date>_v2`).
        //   - `mutator(prev) → next`: pure function. Receives the current
        //     cached payload (or `null` on cold cache). Returns the projected
        //     post-mutation payload. Returning `null`/`undefined` clears the
        //     cache entry (e.g. `workout_next` after the current session
        //     finishes).
        //   - `tags`: SWR tags the dispatched `datastore:changed` event carries.
        //     Drives existing `requestTabRefresh` subscribers.
        //
        // Returns `{ commit(serverPayload), rollback() }`:
        //   - `commit` overwrites the cache with the authoritative server
        //     payload and re-dispatches `datastore:changed`. Use after the
        //     POST resolves. If `serverPayload` is null/undefined the cache
        //     is left in the optimistic state (server returned no body to
        //     reconcile against).
        //   - `rollback` restores the prior cache snapshot (or clears it if
        //     cold) so the screen can repaint to the pre-optimistic state.
        //     Use on POST failure. The next loadSWR call will fetchFresh
        //     normally and reconcile against the authoritative server state.
        //
        // Both `commit` and `rollback` are no-ops after the first call to
        // either, so callers can pass the handle through try/catch without
        // worrying about double-settle.
        async applyOptimistic(key, mutator, tags = []) {
            if (!key || typeof mutator !== 'function') {
                return { commit: async () => {}, rollback: async () => {} };
            }

            let prior = null;
            try {
                prior = await this.getCached(key);
            } catch (_e) { /* tolerate read failures — treat as cold cache */ }

            const priorSnapshot = hasValue(prior) ? deepCloneSnapshot(prior) : prior;

            const next = mutator(prior);

            // Mark this key as having a pending optimistic write before the
            // dispatch fires reloadCurrentTab → loadSWR. Without this, the
            // concurrent fetchFresh would resolve with pre-write server state
            // (the caller's POST hasn't reached the server yet) and write
            // stale data into the cache, flickering the screen between
            // optimistic → stale → real.
            pendingOptimistic.set(key, (pendingOptimistic.get(key) || 0) + 1);

            const decrementPending = () => {
                const c = (pendingOptimistic.get(key) || 0) - 1;
                if (c <= 0) pendingOptimistic.delete(key);
                else pendingOptimistic.set(key, c);
            };

            try {
                if (hasValue(next)) {
                    await this.setCachedWithTags(key, next, tags);
                } else {
                    await this.clearCached(key);
                    registerKeyTags(key, tags);
                }
            } catch (e) {
                // The cache write failed (IndexedDB quota, corruption, etc.)
                // so no optimistic state was actually committed. Roll back
                // the pending counter so future fetchFresh calls don't stay
                // permanently short-circuited, then surface the error.
                decrementPending();
                throw e;
            }

            this.requestTabRefresh(tags, 'optimistic');

            const self = this;
            let settled = false;
            return {
                async commit(serverPayload) {
                    if (settled) return;
                    settled = true;
                    // try/finally so a cache-write failure (IndexedDB quota,
                    // corruption) still decrements the pending counter —
                    // otherwise fetchFresh would short-circuit forever.
                    try {
                        if (hasValue(serverPayload)) {
                            await self.setCachedWithTags(key, serverPayload, tags);
                        }
                    } finally {
                        decrementPending();
                    }
                    self.requestTabRefresh(tags, 'optimistic-commit');
                },
                async rollback() {
                    if (settled) return;
                    settled = true;
                    try {
                        if (hasValue(priorSnapshot)) {
                            await self.setCachedWithTags(key, priorSnapshot, tags);
                        } else {
                            await self.clearCached(key);
                        }
                    } finally {
                        decrementPending();
                    }
                    self.requestTabRefresh(tags, 'optimistic-rollback');
                }
            };
        },

        // Cold-start primer: read a long-lived Dexie record and seed
        // `setCached(key, data)` so subsequent loadSWR/getCached calls find
        // data immediately — even when bootstrap has not yet returned (or
        // never will, if offline).
        //
        // Contract:
        //   - `dexieLoader` is a 0-arg async fn returning either a raw value
        //     OR a `{ data, timestamp }` record. The richer shape lets the
        //     stale badge surface real age (preserved via ApiCache.setWithMeta);
        //     a raw value still hydrates but the badge will fall back to "now".
        //   - `opts.transform` reshapes the data before it lands in the cache.
        //   - `opts.tags` registers the key with DataStore's tag index so a
        //     later invalidateByTag eventually evicts the hydrated entry.
        //
        // Freshness guard: if ApiCache already holds an entry whose timestamp
        // is at least as recent as the Dexie record, the call is a no-op so a
        // bootstrap-served value (or a previous hydration with a fresher row)
        // can't be clobbered by a stale Dexie cache.
        //
        // Never throws — hydration must not block first paint. On any
        // failure path returns `{ hydrated: false }`.
        async hydrateFromDexie(key, dexieLoader, opts = {}) {
            if (!key || typeof dexieLoader !== 'function') {
                return { hydrated: false };
            }
            // Tolerate `null` (caller passing through an optional config) — default
            // params only kick in for `undefined`, so destructuring `null` would
            // throw and violate the never-throws contract documented above.
            const { transform, tags } = opts || {};

            let record;
            try {
                record = await dexieLoader();
            } catch (_e) {
                return { hydrated: false };
            }
            if (!hasValue(record)) return { hydrated: false };

            let rawData;
            let dexieTs = null;
            if (
                typeof record === 'object'
                && !Array.isArray(record)
                && Object.prototype.hasOwnProperty.call(record, 'data')
            ) {
                rawData = record.data;
                if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
                    dexieTs = record.timestamp;
                }
            } else {
                rawData = record;
            }
            if (!hasValue(rawData)) return { hydrated: false };

            // Defense-in-depth: re-register the key's tags even though the
            // CacheKeys registry already does this at boot. Cheap and keeps
            // hydration self-sufficient when caller passes a one-off tag.
            registerKeyTags(key, tags || []);

            const apiCache = window.MedTrackerDB?.ApiCache;
            if (apiCache && typeof apiCache.getWithMeta === 'function' && dexieTs !== null) {
                try {
                    const existing = await apiCache.getWithMeta(key);
                    if (
                        existing
                        && typeof existing.timestamp === 'number'
                        && Number.isFinite(existing.timestamp)
                        && existing.timestamp >= dexieTs
                    ) {
                        return { hydrated: false, fetchedAt: existing.timestamp };
                    }
                } catch (_e) { /* best-effort */ }
            }

            let value = rawData;
            if (typeof transform === 'function') {
                try {
                    value = transform(rawData);
                } catch (_e) {
                    return { hydrated: false };
                }
            }
            if (!hasValue(value)) return { hydrated: false };

            try {
                if (apiCache && typeof apiCache.setWithMeta === 'function' && dexieTs !== null) {
                    await apiCache.setWithMeta(key, value, dexieTs);
                } else {
                    await this.setCached(key, value);
                }
            } catch (_e) {
                return { hydrated: false };
            }

            return { hydrated: true, fetchedAt: dexieTs ?? Date.now() };
        },

        async clearCached(key) {
            // Bump generation and drop the in-flight entry first so any
            // pre-existing fetchFresh promise that resolves after this clear
            // cannot repopulate the cache with stale data.
            if (key) {
                fetchGeneration.set(key, (fetchGeneration.get(key) || 0) + 1);
                inFlight.delete(key);
            }
            if (!window.MedTrackerDB?.ApiCache) return;
            await window.MedTrackerDB.ApiCache.clear(key);
        },

        // Read-only peek at the current generation counter for a key. Used by
        // cachedFetch to detect mid-flight invalidations: if the generation
        // changed between the start of a fetch and its resolution, the
        // resolved payload is older than the authoritative state DataStore now
        // holds and must not be written back to the cache.
        peekGeneration(key) {
            return fetchGeneration.get(key) || 0;
        },

        // Read-only peek at the pending-optimistic counter for a key. Used by
        // cachedFetch to suppress background revalidation writes during the
        // optimistic window — the caller's POST hasn't reached the server yet,
        // so a concurrent GET would resolve with pre-write state and overwrite
        // the optimistic cache.
        hasPendingOptimistic(key) {
            return (pendingOptimistic.get(key) || 0) > 0;
        },

        // (Removed: hasAnyPendingOptimistic. It existed only as cloud sync's
        // self-echo guard and was wrong for it — a settings write never goes
        // through applyOptimistic, so the guard passed and the user was told
        // "New data is available" about their own toggle. web/cloud/js/sync.js
        // now decides on the write's ORIGIN, which is known at the call site.
        // See bd med-dvr.)

        async fetchFresh(key, fetcher, tags = []) {
            registerKeyTags(key, tags);
            if (inFlight.has(key)) return await inFlight.get(key);

            // While an optimistic write is pending for this key, the caller's
            // own POST has not yet reached the server. A GET issued now would
            // return the pre-write state and overwrite the optimistic cache.
            // Skip the network call and return null — loadSWR's `wasSuperseded`
            // detection treats null + bumped generation as a no-render signal.
            // Bump generation explicitly so that detection still fires (the
            // caller may have already snapshotted genBefore expecting a bump).
            if ((pendingOptimistic.get(key) || 0) > 0) {
                fetchGeneration.set(key, (fetchGeneration.get(key) || 0) + 1);
                return null;
            }

            // Capture the current generation for this key so that a cancelled
            // in-flight (evicted by invalidateByTag) cannot overwrite the cache
            // with stale data when it eventually resolves.
            const gen = (fetchGeneration.get(key) || 0) + 1;
            fetchGeneration.set(key, gen);

            const request = (async () => {
                const fresh = await fetcher();
                if (!hasValue(fresh)) return fresh;
                if (fetchGeneration.get(key) !== gen) {
                    // Superseded by setCachedWithTags/clearCached/invalidateByTag
                    // while this request was in flight. Don't write the stale
                    // payload to the cache, and return null so callers
                    // (loadSWR's onFresh, direct callers) don't repaint UI with
                    // a value the authoritative source has already replaced.
                    return null;
                }
                await this.setCached(key, fresh);
                return fresh;
            })().finally(() => {
                // Only clear the slot if it still holds this request. An older
                // abandoned fetch (evicted by clearCached/invalidateByTag) must
                // not remove a newer replacement that now occupies the slot.
                if (inFlight.get(key) === request) {
                    inFlight.delete(key);
                }
            });

            inFlight.set(key, request);
            return await request;
        },

        async loadSWR(options) {
            const {
                key,
                tags = [],
                fetcher,
                onCached,
                onFresh,
                onError,
                allowNullFresh = false
            } = options;

            registerKeyTags(key, tags);

            const cached = await this.getCached(key);
            if (hasValue(cached) && onCached) {
                await onCached(cached);
            }

            try {
                // Snapshot fetchFresh's expected effect on the generation counter
                // so we can detect a mid-flight supersede. A fresh fetch bumps
                // generation by 1; a reused in-flight promise does not bump.
                // Anything beyond that means invalidateByTag / clearCached /
                // setCachedWithTags ran while the fetch was pending, so the null
                // returned below is a supersede signal — not a genuine "backend
                // returned no data" — and onFresh must not repaint UI with it.
                const reusedInFlight = inFlight.has(key);
                const genBefore = fetchGeneration.get(key) || 0;
                const expectedBump = reusedInFlight ? 0 : 1;
                const fresh = await this.fetchFresh(key, fetcher, tags);
                const genAfter = fetchGeneration.get(key) || 0;
                // fetchFresh returns null in three cases:
                //   (a) the fetcher genuinely produced no data,
                //   (b) the request was superseded by an invalidation that
                //       bumped generation past `genBefore + expectedBump`,
                //   (c) a pending optimistic write short-circuited the GET so
                //       the optimistic cache stays authoritative until commit.
                // (a) is the only case where onFresh(null) should fire under
                // allowNullFresh — (b) and (c) would wipe rendered UI back to
                // an empty/stale state.
                const pendingOptimisticActive = (pendingOptimistic.get(key) || 0) > 0;
                const wasSuperseded = fresh === null
                    && (genAfter > genBefore + expectedBump || pendingOptimisticActive);
                if (!wasSuperseded && (allowNullFresh || hasValue(fresh)) && onFresh) {
                    await onFresh(fresh, cached);
                }
                return { cached, fresh: wasSuperseded ? null : fresh };
            } catch (error) {
                if (onError) {
                    await onError(error, cached);
                } else {
                    console.warn(`[DataStore] loadSWR fetch failed for key="${key}", using cached data`, error);
                }
                return { cached, fresh: null, error };
            }
        },

        async invalidateByTag(tag) {
            const registered = tagToKeys.get(tag);
            const prefixes = tagFamilies.get(tag);

            // Phase 1 (synchronous): bump generation and drop the in-flight
            // slot for every explicitly-registered key BEFORE any await.
            // Otherwise a pending fetchFresh whose fetcher resolves during
            // the family-prefix scan below would see the un-bumped generation,
            // pass its supersede check, write stale data into the cache, and
            // repaint UI via loadSWR's onFresh. Doing the bump synchronously
            // here forces those resolutions to detect the supersede and abort.
            const toEvict = new Set(registered || []);
            for (const key of toEvict) {
                fetchGeneration.set(key, (fetchGeneration.get(key) || 0) + 1);
                inFlight.delete(key);
            }

            // Phase 2 (async): extend the eviction set with family-prefix
            // matches. Newly-discovered keys also need their generation bumped
            // + in-flight slot dropped before clearCached runs.
            if (prefixes && prefixes.size > 0) {
                const apiCache = window.MedTrackerDB?.ApiCache;
                const staticRegistry = (window.CacheKeys && window.CacheKeys.static) || {};
                if (apiCache && typeof apiCache.keys === 'function') {
                    for (const prefix of prefixes) {
                        const matched = await apiCache.keys(prefix);
                        if (Array.isArray(matched)) {
                            for (const key of matched) {
                                // A static-registered key whose tag differs
                                // from the current tag is opted out of the
                                // family-prefix sweep — e.g. `food_targets`
                                // lives under the `food_` prefix but is
                                // registered with tag=null because the row is
                                // overwritten on save, not invalidated by the
                                // food log family.
                                const reg = staticRegistry[key];
                                if (reg && reg.tag !== tag) continue;
                                if (toEvict.has(key)) continue;
                                fetchGeneration.set(key, (fetchGeneration.get(key) || 0) + 1);
                                inFlight.delete(key);
                                toEvict.add(key);
                            }
                        }
                    }
                }
            }

            if (toEvict.size === 0) return;

            await Promise.all([...toEvict].map((key) => this.clearCached(key)));
        },

        async invalidateTags(tags = []) {
            for (const tag of tags) {
                await this.invalidateByTag(tag);
            }
        },

        async invalidateKey(key) {
            await this.clearCached(key);
        },

        requestTabRefresh(changedTags = [], source = 'changes') {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                try {
                    window.dispatchEvent(new CustomEvent('datastore:changed', { detail: { changedTags, source } }));
                } catch (_) { /* dispatch is best-effort */ }
            }
            if (typeof window.requestTabRefresh === 'function') {
                window.requestTabRefresh({ changedTags, source });
                return;
            }
            if (window.reloadCurrentTab) {
                window.reloadCurrentTab();
            }
        }
    };

    window.DataStore = DataStore;
})();
