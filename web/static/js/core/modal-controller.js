// core/modal-controller.js
// Lightweight submit-guard for modal forms.
// Prevents double-submission by disabling the button while async work runs.

/**
 * Wrap an async submit handler with a double-submit guard.
 * The button is disabled for the duration of `asyncFn`, then re-enabled.
 *
 * @param {HTMLButtonElement|null} btn  - Submit button (null to skip the guard).
 * @param {function():Promise} asyncFn  - The async work to perform.
 */
async function withSubmit(btn, asyncFn) {
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
        await asyncFn();
    } finally {
        if (btn) btn.disabled = false;
    }
}
