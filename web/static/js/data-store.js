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
    const keyToTags = new Map();
    const tagToKeys = new Map();
    // tag → Set<prefix>. Lets `invalidateByTag(tag)` evict every concrete
    // dynamic key (`history_7_42`, `food_2026-05-14_day`, …) whose id starts
    // with one of the registered prefixes, without each call site having to
    // pre-enumerate the dynamic family.
    const tagFamilies = new Map();
    const CHANGE_CURSOR_KEY = 'medtracker_changes_cursor';
    const CACHE_PRUNE_AT_KEY = 'medtracker_cache_pruned_at';
    const CHANGE_POLL_INTERVAL_MS = 30000;
    const CHANGE_STREAM_RETRY_MS = 5000;
    const CHANGE_STREAM_MAX_RETRY_MS = 30000;
    const CHANGE_STREAM_AUTH_PROBE_ERRORS = 3;
    const CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const CACHE_MAX_AGE_DEFAULT_MS = 14 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_AGE_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_AGE_HIGH_FREQ_MS = 3 * 24 * 60 * 60 * 1000;
    let changePollTimer = null;
    let changePollInFlight = false;
    let changeStream = null;
    let changeStreamRetryTimer = null;
    let changeStreamErrorCount = 0;
    let changeStreamRetryDelayMs = CHANGE_STREAM_RETRY_MS;
    let changeAuthProbeInFlight = false;
    let changeUnauthorized = false;

    const hasValue = (value) => value !== null && value !== undefined;

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

        async fetchFresh(key, fetcher, tags = []) {
            registerKeyTags(key, tags);
            if (inFlight.has(key)) return await inFlight.get(key);

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
                const wasSuperseded = fresh === null && genAfter > genBefore + expectedBump;
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

        getChangeCursor() {
            const raw = localStorage.getItem(CHANGE_CURSOR_KEY);
            const parsed = raw ? parseInt(raw, 10) : 0;
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        },

        setChangeCursor(cursor) {
            const parsed = Number(cursor);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            localStorage.setItem(CHANGE_CURSOR_KEY, String(Math.floor(parsed)));
        },

        async applyChangesPayload(res) {
            if (!res || typeof res.cursor !== 'number') return;

            const changedTags = Array.isArray(res.changed_tags) ? res.changed_tags : [];
            const prevCursor = this.getChangeCursor();
            if (changedTags.length > 0) {
                console.log('[changes] tags=%o cursor=%d→%d', changedTags, prevCursor, res.cursor);
                await this.invalidateTags(changedTags);
                this.requestTabRefresh(changedTags);
            } else {
                console.debug('[changes] no changes, cursor=%d→%d', prevCursor, res.cursor);
            }

            this.setChangeCursor(res.cursor);
        },

        requestTabRefresh(changedTags = []) {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                try {
                    window.dispatchEvent(new CustomEvent('datastore:changed', { detail: { changedTags, source: 'changes' } }));
                } catch (_) { /* dispatch is best-effort */ }
            }
            if (typeof window.requestTabRefresh === 'function') {
                window.requestTabRefresh({ changedTags, source: 'changes' });
                return;
            }
            if (window.reloadCurrentTab) {
                window.reloadCurrentTab();
            }
        },

        handleUnauthorized() {
            if (changeUnauthorized) return;
            changeUnauthorized = true;
            this.stopChangePolling();
            if (typeof window.onDataStoreUnauthorized === 'function') {
                window.onDataStoreUnauthorized();
            }
        },

        async verifyAuthSession() {
            if (changeAuthProbeInFlight || !window.apiCallDirect) return;
            changeAuthProbeInFlight = true;
            try {
                const since = this.getChangeCursor();
                await window.apiCallDirect(`/api/changes?since=${since}`, 'GET');
            } catch (e) {
                if (e?.message === 'Unauthorized') {
                    this.handleUnauthorized();
                }
            } finally {
                changeAuthProbeInFlight = false;
            }
        },

        getCacheMaxAgeMsByKey(key) {
            if (!key) return CACHE_MAX_AGE_DEFAULT_MS;
            if (key.startsWith('history_') || key.startsWith('food_')) return CACHE_MAX_AGE_HISTORY_MS;
            if (key === 'bp' || key === 'weight' || key.startsWith('workout_')) return CACHE_MAX_AGE_HIGH_FREQ_MS;
            return CACHE_MAX_AGE_DEFAULT_MS;
        },

        async pruneStaleClientCache() {
            const db = window.MedTrackerDB?.db;
            if (!db?.api_cache) return;

            const now = Date.now();
            const lastPrunedRaw = localStorage.getItem(CACHE_PRUNE_AT_KEY);
            const lastPruned = lastPrunedRaw ? parseInt(lastPrunedRaw, 10) : 0;
            if (Number.isFinite(lastPruned) && now-lastPruned < CACHE_PRUNE_INTERVAL_MS) {
                return;
            }

            try {
                const rows = await db.api_cache.toArray();
                for (const row of rows) {
                    const maxAge = this.getCacheMaxAgeMsByKey(row.id);
                    if (!row.timestamp || now-row.timestamp > maxAge) {
                        await db.api_cache.delete(row.id);
                    }
                }
                localStorage.setItem(CACHE_PRUNE_AT_KEY, String(now));
            } catch (_e) {
                // Ignore cache prune failures.
            }
        },

        async pollChangesOnce() {
            if (changePollInFlight) return;
            if (!window.apiCallDirect) return;

            changePollInFlight = true;
            try {
                const since = this.getChangeCursor();
                const res = await window.apiCallDirect(`/api/changes?since=${since}`, 'GET');
                await this.applyChangesPayload(res);
            } catch (e) {
                if (e?.message === 'Unauthorized') {
                    this.handleUnauthorized();
                    return;
                }
                // Ignore transient polling errors (offline / network race).
            } finally {
                changePollInFlight = false;
            }
        },

        // Advance the change cursor without triggering a tab refresh.
        // Called after the client itself performs a write, so that the next
        // scheduled poll does not re-notify about the client's own changes.
        //
        // Must NOT invalidate tags. This runs fire-and-forget from
        // apiCallDirect after every successful write, so the /api/changes
        // response typically lands DURING the caller's own post-write
        // refresh flow (e.g. saveFoodLog → invalidateTags → loadToday →
        // fetchFresh). Invalidating here would bump the fetchGeneration of
        // the key the caller just scheduled a refetch for, causing the
        // resolving response to be dropped as "superseded" and leaving the
        // cache empty — the Today fuel/weight/BP tile then re-renders at 0
        // after a save. Callers are expected to invalidate their own write's
        // tag explicitly; cross-client changes are picked up by the next
        // scheduled poll.
        async advanceCursorSilently() {
            if (!window.apiCallDirect) return;
            try {
                const since = this.getChangeCursor();
                const res = await window.apiCallDirect(`/api/changes?since=${since}`, 'GET');
                if (!res || typeof res.cursor !== 'number') return;
                this.setChangeCursor(res.cursor);
            } catch (_e) {
                // Best-effort; the regular poll will catch up.
            }
        },

        startChangePollInterval() {
            if (changePollTimer) return;
            changePollTimer = setInterval(() => {
                if (navigator.onLine) {
                    this.pollChangesOnce();
                }
            }, CHANGE_POLL_INTERVAL_MS);
        },

        stopChangePollInterval() {
            if (!changePollTimer) return;
            clearInterval(changePollTimer);
            changePollTimer = null;
        },

        buildChangesStreamURL() {
            const params = new URLSearchParams();
            params.set('since', String(this.getChangeCursor()));
            if (window.userInitData) {
                params.set('initData', window.userInitData);
            }
            return `/api/changes/stream?${params.toString()}`;
        },

        startChangeStream() {
            if (changeStream || typeof EventSource === 'undefined' || !navigator.onLine) {
                return false;
            }

            try {
                const source = new EventSource(this.buildChangesStreamURL());
                changeStream = source;

                source.onopen = () => {
                    changeStreamErrorCount = 0;
                    changeStreamRetryDelayMs = CHANGE_STREAM_RETRY_MS;
                    this.stopChangePollInterval();
                };

                source.onmessage = async (event) => {
                    if (!event?.data) return;
                    try {
                        const payload = JSON.parse(event.data);
                        await this.applyChangesPayload(payload);
                    } catch (_e) {
                        // Ignore malformed events.
                    }
                };

                source.onerror = () => {
                    if (changeStream) {
                        changeStream.close();
                        changeStream = null;
                    }
                    changeStreamErrorCount += 1;
                    this.startChangePollInterval();
                    if (changeStreamErrorCount >= CHANGE_STREAM_AUTH_PROBE_ERRORS) {
                        this.verifyAuthSession();
                    }
                    if (!changeStreamRetryTimer) {
                        changeStreamRetryTimer = setTimeout(() => {
                            changeStreamRetryTimer = null;
                            if (this.startChangeStream()) {
                                this.stopChangePollInterval();
                            }
                        }, changeStreamRetryDelayMs);
                        changeStreamRetryDelayMs = Math.min(changeStreamRetryDelayMs * 2, CHANGE_STREAM_MAX_RETRY_MS);
                    }
                };

                return true;
            } catch (_e) {
                if (changeStream) {
                    changeStream.close();
                    changeStream = null;
                }
                return false;
            }
        },

        startChangePolling() {
            if (changeUnauthorized) return;
            if (changeStream || changePollTimer) return;
            this.pruneStaleClientCache();

            // SSE (EventSource) over HTTP/2 behind reverse proxies (Traefik, nginx)
            // is fundamentally broken: every server-side stream close sends RST_STREAM
            // which surfaces as ERR_HTTP2_PROTOCOL_ERROR in the browser console.
            // Polling at 30s is lightweight and reliable — use it exclusively.
            this.startChangePollInterval();
        },

        stopChangePolling() {
            this.stopChangePollInterval();
            if (changeStream) {
                changeStream.close();
                changeStream = null;
            }
            if (changeStreamRetryTimer) {
                clearTimeout(changeStreamRetryTimer);
                changeStreamRetryTimer = null;
            }
            changeStreamErrorCount = 0;
            changeStreamRetryDelayMs = CHANGE_STREAM_RETRY_MS;
        }
    };

    window.DataStore = DataStore;
})();
