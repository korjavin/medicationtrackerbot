// cached-fetch.js — local-first read-through wrapper.
//
// Promotes the existing api_cache + cacheApiSnapshot machinery into a single
// entry point that every priority section can call. Inherits the project-wide
// "5xx-as-offline" policy from sync.js so a backend behind a 502/503 proxy
// behaves identically to a true network outage.
//
// Behavior matrix:
//   1. Cache hit, online       → return cached immediately, kick off
//                                background revalidation (SWR).
//   2. Cache miss, online      → fetch, write to cache, return fresh.
//   3. Cache hit, offline/5xx  → return cached, isFromCache:true, isStale flag
//                                set if age > staleAfterMs.
//   4. Cache miss, offline/5xx → throw OfflineNoCacheError so callers can
//                                render an explicit empty state.

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
        if (typeof err.status === 'number' && err.status >= 500) return true;
        const msg = err.message || '';
        if (typeof TypeError !== 'undefined' && err instanceof TypeError) return true;
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
        const raw = await direct(url, method, body);
        return typeof transform === 'function' ? transform(raw) : raw;
    }

    // cachedFetch(key, url, opts) — see module banner for behaviour.
    async function cachedFetch(key, url, opts = {}) {
        const {
            tags = [],
            freshAfterMs = 60_000,
            staleAfterMs = 24 * 60 * 60 * 1000,
            transform,
            fetchOpts,
            now = Date.now()
        } = opts;

        const cached = await readCache(key);
        const cachedTs = cached && typeof cached.timestamp === 'number' ? cached.timestamp : null;
        const cachedAge = cachedTs == null ? Infinity : Math.max(0, now - cachedTs);
        const cachedIsFresh = cachedAge <= freshAfterMs;
        const online = isOnline();

        // Online path
        if (online) {
            // Fresh cache → return immediately, background revalidate.
            if (cached && cachedIsFresh) {
                queueMicrotask(() => {
                    performFetch(url, fetchOpts, transform)
                        .then((fresh) => {
                            if (fresh != null) return writeCache(key, fresh, tags);
                            return undefined;
                        })
                        .catch(() => { /* background refresh failures swallowed */ });
                });
                return {
                    data: cached.data,
                    fetchedAt: cachedTs,
                    isFromCache: true,
                    isStale: false
                };
            }

            // No cache or stale → fetch, fall back to cache on network/5xx error.
            try {
                const fresh = await performFetch(url, fetchOpts, transform);
                if (fresh != null) {
                    await writeCache(key, fresh, tags);
                    return {
                        data: fresh,
                        fetchedAt: Date.now(),
                        isFromCache: false,
                        isStale: false
                    };
                }
                // Backend returned null/undefined — surface cached if any, else null payload.
                if (cached) {
                    return {
                        data: cached.data,
                        fetchedAt: cachedTs,
                        isFromCache: true,
                        isStale: cachedAge > staleAfterMs
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
                if (cached) {
                    return {
                        data: cached.data,
                        fetchedAt: cachedTs,
                        isFromCache: true,
                        isStale: cachedAge > staleAfterMs
                    };
                }
                throw new OfflineNoCacheError(key, err);
            }
        }

        // Offline path — never even attempt the network.
        if (cached) {
            return {
                data: cached.data,
                fetchedAt: cachedTs,
                isFromCache: true,
                isStale: cachedAge > staleAfterMs
            };
        }
        throw new OfflineNoCacheError(key);
    }

    window.cachedFetch = cachedFetch;
    window.OfflineNoCacheError = OfflineNoCacheError;
})();
