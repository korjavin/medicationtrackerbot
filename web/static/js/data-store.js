// DataStore: unified client-side state access for API-backed resources.
// Provides:
// - Stale-while-revalidate loader
// - In-flight request deduplication per cache key
// - Tag-based cache invalidation
(function () {
    const inFlight = new Map();
    const keyToTags = new Map();
    const tagToKeys = new Map();
    const CHANGE_CURSOR_KEY = 'medtracker_changes_cursor';
    const CACHE_PRUNE_AT_KEY = 'medtracker_cache_pruned_at';
    const CHANGE_POLL_INTERVAL_MS = 30000;
    const CHANGE_STREAM_RETRY_MS = 5000;
    const CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const CACHE_MAX_AGE_DEFAULT_MS = 14 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_AGE_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_AGE_HIGH_FREQ_MS = 3 * 24 * 60 * 60 * 1000;
    let changePollTimer = null;
    let changePollInFlight = false;
    let changeStream = null;
    let changeStreamRetryTimer = null;

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

        async clearCached(key) {
            if (!window.MedTrackerDB?.ApiCache) return;
            await window.MedTrackerDB.ApiCache.clear(key);
        },

        async fetchFresh(key, fetcher, tags = []) {
            registerKeyTags(key, tags);
            if (inFlight.has(key)) return await inFlight.get(key);

            const request = (async () => {
                const fresh = await fetcher();
                if (hasValue(fresh)) {
                    await this.setCached(key, fresh);
                }
                return fresh;
            })().finally(() => {
                inFlight.delete(key);
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
                const fresh = await this.fetchFresh(key, fetcher, tags);
                if ((allowNullFresh || hasValue(fresh)) && onFresh) {
                    await onFresh(fresh, cached);
                }
                return { cached, fresh };
            } catch (error) {
                if (onError) {
                    await onError(error, cached);
                } else {
                    throw error;
                }
                return { cached, fresh: null, error };
            }
        },

        async invalidateByTag(tag) {
            const keys = tagToKeys.get(tag);
            if (!keys || keys.size === 0) return;

            await Promise.all([...keys].map((key) => this.clearCached(key)));
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
            if (changedTags.length > 0) {
                await this.invalidateTags(changedTags);
                if (window.reloadCurrentTab) {
                    const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
                    if (activeTab === 'settings' && typeof window.loadSettings === 'function') {
                        window.loadSettings();
                    } else if (activeTab === 'food' && typeof window.loadFoodLogs === 'function') {
                        window.loadFoodLogs();
                    } else if (activeTab === 'health' && typeof window.loadHealthOverview === 'function') {
                        window.loadHealthOverview();
                    } else {
                        window.reloadCurrentTab();
                    }
                }
            }

            this.setChangeCursor(res.cursor);
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
                // Ignore transient polling errors (offline / auth race).
            } finally {
                changePollInFlight = false;
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
                    this.startChangePollInterval();
                    if (!changeStreamRetryTimer) {
                        changeStreamRetryTimer = setTimeout(() => {
                            changeStreamRetryTimer = null;
                            if (this.startChangeStream()) {
                                this.stopChangePollInterval();
                            }
                        }, CHANGE_STREAM_RETRY_MS);
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
            if (changeStream || changePollTimer) return;
            this.pruneStaleClientCache();

            if (!this.startChangeStream()) {
                this.startChangePollInterval();
            }
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
        }
    };

    window.DataStore = DataStore;
})();
