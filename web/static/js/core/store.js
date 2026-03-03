// core/store.js
// Lightweight UI-state container for ephemeral application state.
// Does NOT replace sync.js/data-store.js (which own network + IndexedDB cache).
// Holds only feature-level UI state that needs to be visible across modules.

(function () {
    const _state = {};
    const _listeners = new Map();

    const AppStore = {
        /**
         * Read a state value.
         * @param {string} key
         * @returns {*}
         */
        get(key) {
            return _state[key];
        },

        /**
         * Write a state value and notify subscribers.
         * @param {string} key
         * @param {*} value
         */
        set(key, value) {
            _state[key] = value;
            const handlers = _listeners.get(key);
            if (handlers) {
                handlers.forEach(h => h(value));
            }
        },

        /**
         * Subscribe to changes on a single key.
         * @param {string} key
         * @param {function(*):void} handler
         */
        subscribe(key, handler) {
            if (!_listeners.has(key)) _listeners.set(key, []);
            _listeners.get(key).push(handler);
        }
    };

    window.AppStore = AppStore;
})();
