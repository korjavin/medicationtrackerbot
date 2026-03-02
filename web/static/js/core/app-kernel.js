// AppKernel — module registry and lifecycle hooks.
// Provides a stable interface for feature modules to register themselves and
// receive lifecycle events (onTabSwitch, onAuth). Loaded before app.js.
//
// Usage:
//   window.AppKernel.register('myFeature', {
//     onTabSwitch(tab) { ... },   // optional
//     onAuth(authorized) { ... }  // optional
//   });
//
// app.js and features/* call AppKernel.onTabSwitch / AppKernel.onAuth at the
// relevant points in the lifecycle.

(function () {
    const _modules = new Map();

    const AppKernel = {
        /** Register a named feature module with optional lifecycle hooks. */
        register(name, module) {
            _modules.set(name, module);
            return AppKernel;
        },

        /** Retrieve a registered module by name. */
        get(name) {
            return _modules.get(name);
        },

        /**
         * Notify all registered modules that the active tab changed.
         * Called by switchTab() in app.js.
         */
        onTabSwitch(tab) {
            for (const [, mod] of _modules) {
                if (typeof mod.onTabSwitch === 'function') mod.onTabSwitch(tab);
            }
        },

        /**
         * Notify all registered modules that authentication completed.
         * Called after checkAuth() resolves.
         */
        onAuth(authorized) {
            for (const [, mod] of _modules) {
                if (typeof mod.onAuth === 'function') mod.onAuth(authorized);
            }
        },

        /**
         * Schedule a callback to run after DOM is ready.
         * Fires immediately if DOMContentLoaded has already fired.
         */
        onReady(fn) {
            if (document.readyState !== 'loading') {
                fn();
            } else {
                document.addEventListener('DOMContentLoaded', fn, { once: true });
            }
        }
    };

    window.AppKernel = AppKernel;
})();
