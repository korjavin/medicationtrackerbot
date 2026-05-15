// cached-fetch.js — local-first read-through wrapper.
//
// Promotes the existing api_cache + cacheApiSnapshot machinery into a single
// entry point that every priority section can call. Inherits the project-wide
// "5xx-as-offline" policy from sync.js so a backend behind a 502/503 proxy
// behaves identically to a true network outage.
//
// Behavior matrix:
//   1. Cache hit, online       → return cached immediately, kick off
//                                background revalidation (SWR). Applies to
//                                any cache hit regardless of age — older
//                                entries surface with `isStale:true` so the
//                                badge can flag them while the background
//                                refresh lands.
//   2. Cache miss, online      → fetch, write to cache, return fresh.
//   3. Cache hit, offline/5xx  → return cached, isFromCache:true, isStale flag
//                                set if age > staleAfterMs.
//   4. Cache miss, offline/5xx → throw OfflineNoCacheError so callers can
//                                render an explicit empty state.
//
// Generation guard: writes to the cache after a network round-trip are
// dropped if DataStore's generation counter for the key advanced while the
// fetch was in flight (mutation/invalidation/setCachedWithTags). Without the
// guard, an older GET completing after an authoritative write could resurrect
// stale data — the same race fetchFresh already protects against.

(function () {
    class OfflineNoCacheError extends Error {
        constructor(key, cause) {
            super(`No cached data for "${key}" and network is unavailable`);
            this.name = 'OfflineNoCacheError';
            this.key = key;
            if (cause) this.cause = cause;
        }
    }

    function isOnline() {
        return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    }

    function looksLikeNetworkError(err) {
        if (!err) return false;
        // Caller-driven aborts (timeouts, signal cancellations) are expected
        // and silent — the foreground caller already has the cached payload
        // and there's nothing for an operator to act on.
        if (err.aborted === true || err.name === 'AbortError' || err.name === 'TimeoutError') {
            return true;
        }
        // Prefer the canonical isServerError helper (sync.js) when loaded so
        // the 5xx-as-offline policy stays defined in one place. Fall back to
        // an inline detector when sync.js hasn't loaded yet (early boot, tests
        // that exercise cached-fetch.js in isolation).
        if (typeof window !== 'undefined' && typeof window.isServerError === 'function') {
            try {
                if (window.isServerError(err)) return true;
            } catch (_) { /* fall through to inline detector */ }
        }
        if (typeof err.status === 'number' && err.status >= 500) return true;
        const msg = err.message || '';
        // Narrow TypeError check (matches sync.js's isNetworkError): only a
        // TypeError that mentions fetch OR is observed while the browser is
        // offline counts as a network failure. A bare TypeError (e.g. "Cannot
        // read property 'x' of undefined" from a transform/contract bug) is
        // a programmer error and must surface, not be silently swallowed by
        // the offline fallback path.
        if (typeof TypeError !== 'undefined' && err instanceof TypeError) {
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            if (offline) return true;
            if (msg.includes('fetch')) return true;
        }
        return (
            msg === 'Network request failed' ||
            msg === 'Failed to fetch' ||
            msg.includes('Bad Gateway') ||
            msg.includes('Service Unavailable') ||
            msg.includes('Gateway Timeout') ||
            msg.includes('502') ||
            msg.includes('503') ||
            msg.includes('504')
        );
    }

    async function readCache(key) {
        const cache = window.MedTrackerDB?.ApiCache;
        if (!cache) return null;
        if (typeof cache.getWithMeta === 'function') {
            return await cache.getWithMeta(key);
        }
        const data = await cache.get(key);
        return data == null ? null : { data, timestamp: null };
    }

    async function writeCache(key, data, tags) {
        if (typeof window.cacheApiSnapshot === 'function') {
            await window.cacheApiSnapshot(key, data, tags || []);
            return;
        }
        if (window.MedTrackerDB?.ApiCache && typeof window.MedTrackerDB.ApiCache.set === 'function') {
            await window.MedTrackerDB.ApiCache.set(key, data);
        }
    }

    async function performFetch(url, fetchOpts, transform) {
        const direct = window.apiCallDirect;
        if (typeof direct !== 'function') {
            throw new Error('apiCallDirect is not available');
        }
        const method = (fetchOpts && fetchOpts.method) || 'GET';
        const body = (fetchOpts && fetchOpts.body) || null;
        // Only build a 4th opts arg when something is set — leaving it off
        // preserves the existing 3-arg call shape that tests assert against
        // and keeps `apiCallDirect`'s default timeout behaviour intact.
        const hasTimeout = fetchOpts && Number.isFinite(fetchOpts.timeoutMs);
        const hasSignal = fetchOpts && fetchOpts.signal;
        const raw = (hasTimeout || hasSignal)
            ? await direct(url, method, body, {
                ...(hasTimeout ? { timeoutMs: fetchOpts.timeoutMs } : {}),
                ...(hasSignal ? { signal: fetchOpts.signal } : {})
            })
            : await direct(url, method, body);
        return typeof transform === 'function' ? transform(raw) : raw;
    }

    function peekGen(key) {
        const ds = (typeof window !== 'undefined') ? window.DataStore : null;
        if (ds && typeof ds.peekGeneration === 'function') {
            try { return ds.peekGeneration(key); } catch (_) { /* fall through */ }
        }
        return null;
    }

    // Defense-in-depth registration. `CacheKeys.registerAll` runs at boot, so
    // every registered key/family already has its tag mapping wired before
    // any cachedFetch call. This call is kept for one-off keys passed inline
    // via `opts.tags` that aren't in the registry.
    function registerTagsWithStore(key, tags) {
        if (!Array.isArray(tags) || tags.length === 0) return;
        const ds = (typeof window !== 'undefined') ? window.DataStore : null;
        if (ds && typeof ds.registerTags === 'function') {
            try { ds.registerTags(key, tags); } catch (_) { /* best-effort */ }
        }
    }

    function resolveTags(key, explicit) {
        if (Array.isArray(explicit) && explicit.length > 0) return explicit;
        const ck = (typeof window !== 'undefined') ? window.CacheKeys : null;
        if (ck && typeof ck.tagFor === 'function') {
            try {
                const tag = ck.tagFor(key);
                if (tag) return [tag];
            } catch (_) { /* registry not loaded or unknown key — fall through */ }
        }
        return [];
    }

    // Performs the network round-trip and writes the result to the cache,
    // dropping the write when DataStore's generation counter advanced
    // mid-flight (mutation/invalidation occurred). Returns the fetched value
    // when the write happened, or null when the write was dropped or the
    // backend returned no value.
    async function performAndCacheFetch(key, url, fetchOpts, transform, tags) {
        const startGen = peekGen(key);
        const fresh = await performFetch(url, fetchOpts, transform);
        if (fresh == null) return null;
        const endGen = peekGen(key);
        if (startGen !== null && endGen !== null && endGen !== startGen) {
            // Superseded by a mutation/invalidation while in flight — the
            // cache now holds the authoritative value (or has been cleared);
            // writing this stale payload back would resurrect it.
            return null;
        }
        await writeCache(key, fresh, tags);
        return fresh;
    }

    // cachedFetch(key, url, opts) — see module banner for behaviour.
    async function cachedFetch(key, url, opts = {}) {
        const {
            tags: explicitTags,
            freshAfterMs = 60_000,
            staleAfterMs = 24 * 60 * 60 * 1000,
            transform,
            fetchOpts,
            timeoutMs,
            now = Date.now()
        } = opts;

        // Thread a caller-supplied timeoutMs through to apiCallDirect via
        // fetchOpts. When unspecified, apiCallDirect's 60s default applies.
        const effectiveFetchOpts = Number.isFinite(timeoutMs)
            ? { ...(fetchOpts || {}), timeoutMs }
            : fetchOpts;

        // Resolve the tag list. An inline `opts.tags` arg overrides the
        // registry — useful for one-off keys not enumerated in
        // `core/cache-keys.js`. Registry hits avoid the per-call boilerplate.
        const tags = resolveTags(key, explicitTags);
        registerTagsWithStore(key, tags);

        const cached = await readCache(key);
        const cachedTs = cached && typeof cached.timestamp === 'number' ? cached.timestamp : null;
        const cachedAge = cachedTs == null ? Infinity : Math.max(0, now - cachedTs);
        const cachedIsFresh = cachedAge <= freshAfterMs;
        const cachedIsStale = cachedAge > staleAfterMs;
        const online = isOnline();

        // Online + cache hit → SWR. The behavior matrix says any cache hit
        // online returns immediately and revalidates in the background; older
        // entries surface with isStale:true so the badge can flag them while
        // the refresh lands. Skip the background fetch for cache that is
        // still within freshAfterMs — there's nothing to refresh.
        if (online && cached) {
            if (!cachedIsFresh) {
                queueMicrotask(() => {
                    performAndCacheFetch(key, url, effectiveFetchOpts, transform, tags)
                        .catch((err) => {
                            // Network/5xx during background revalidation is expected and
                            // already covered by the foreground fallback path — silence
                            // those. Programmer errors (transform throws, contract drift,
                            // unauthorized) should surface in the console so deploys
                            // don't fail silently.
                            if (!looksLikeNetworkError(err) && typeof console !== 'undefined') {
                                console.warn('cachedFetch background revalidation failed', key, err);
                            }
                        });
                });
            } else {
                // Fresh cache: still kick a background refresh so the cache
                // never gets older than freshAfterMs while the user has the
                // tab open. Same gen guard, same error muting.
                queueMicrotask(() => {
                    performAndCacheFetch(key, url, effectiveFetchOpts, transform, tags)
                        .catch((err) => {
                            if (!looksLikeNetworkError(err) && typeof console !== 'undefined') {
                                console.warn('cachedFetch background revalidation failed', key, err);
                            }
                        });
                });
            }
            return {
                data: cached.data,
                fetchedAt: cachedTs,
                isFromCache: true,
                isStale: cachedIsStale
            };
        }

        // Online + cache miss → foreground fetch.
        if (online) {
            try {
                const fresh = await performAndCacheFetch(key, url, effectiveFetchOpts, transform, tags);
                if (fresh != null) {
                    return {
                        data: fresh,
                        fetchedAt: Date.now(),
                        isFromCache: false,
                        isStale: false
                    };
                }
                // fresh == null means either the backend returned no payload
                // OR our write was superseded by a mid-flight invalidation.
                // Re-read so we surface whatever DataStore now considers
                // authoritative (could be a fresh value from setCachedWithTags
                // or null after a clear).
                const latest = await readCache(key);
                if (latest) {
                    const latestTs = typeof latest.timestamp === 'number' ? latest.timestamp : null;
                    const latestAge = latestTs == null ? Infinity : Math.max(0, Date.now() - latestTs);
                    return {
                        data: latest.data,
                        fetchedAt: latestTs,
                        isFromCache: true,
                        isStale: latestAge > staleAfterMs
                    };
                }
                return {
                    data: null,
                    fetchedAt: Date.now(),
                    isFromCache: false,
                    isStale: false
                };
            } catch (err) {
                if (!looksLikeNetworkError(err)) throw err;
                // Network/5xx with no cache (cache hit branch handled above).
                throw new OfflineNoCacheError(key, err);
            }
        }

        // Offline path — never even attempt the network.
        if (cached) {
            return {
                data: cached.data,
                fetchedAt: cachedTs,
                isFromCache: true,
                isStale: cachedIsStale
            };
        }
        throw new OfflineNoCacheError(key);
    }

    window.cachedFetch = cachedFetch;
    window.OfflineNoCacheError = OfflineNoCacheError;
})();
