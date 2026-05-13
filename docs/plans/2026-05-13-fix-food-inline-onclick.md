# Fix inline `onclick=` in `features/food.js:1620`

## Overview

The CSP shipped by the server (`internal/server/server.go:373`) is:

```
script-src 'self' https://telegram.org https://esm.sh blob: data:
```

Critically: **no `'unsafe-inline'`**. Under this CSP, browsers block
inline event handlers (`onclick="…"` attributes); they parse but never
execute.

`features/food.js:1620` builds exactly such a handler:

```javascript
linkContainer.innerHTML = `<a href="#" onclick="navigateToFoodProduct(event, ${log.product_id}, ${log.is_meal ? 'true' : 'false'})" class="food-product-link">${linkText}</a>`;
```

This means one of two things is true today:

1. **The link is silently dead** — clicking "→ View in Products" or
   "→ View Meal" on an edited food log does nothing because the inline
   handler is CSP-blocked. Latent bug.
2. **The deployed CSP allows `'unsafe-inline'`** despite what
   `server.go:373` says — meaning either there's a separate deployed
   config or `unsafe-inline` is being injected somewhere else. Either
   way, the deployed posture is weaker than the source-of-truth file
   suggests.

This plan: (a) confirms which case is real with a single browser test,
(b) replaces the inline handler with an `addEventListener` regardless,
(c) adds an architecture test that bans inline `on*=` attribute strings
inside template literals in JS source.

The fix itself is ~10 lines. The architecture test is the larger value.

**Out of scope:**
- A broader XSS audit of the 96 `innerHTML` writes in production code
  (most are static templates with no interpolation; spot-check
  separately if needed).
- Adopting Trusted Types — separate platform-level decision.

From the [2026-05-13 frontend review §10](../2026-05-13-frontend-code-review.md#10-xss-surface-and-csp-blocked-inline-onclick)
and recommended-priority item #10.

## Context (from discovery)

- **The single offending site**: `web/static/js/features/food.js:1620`.
  Built inside `editFoodLog()` (or whatever function owns this DOM
  node — read the surrounding ~30 lines to confirm).
- **The function the handler calls**: `navigateToFoodProduct(event,
  productId, isMeal)`. Defined elsewhere in `food.js` (grep to
  locate). Already a global function — fine to call from a JS-attached
  listener.
- **The CSP**: `internal/server/server.go:373`. The string is the
  source of truth; verify by curling the homepage and checking
  `Content-Security-Policy` header on the deployed site (Post-Completion
  manual step).
- **Other inline event handlers**: grep confirmed only this one site
  uses an inline `onclick=` template; all other event wiring goes
  through `addEventListener`.

## Development Approach

- **Testing approach**: Regular.
- Single PR; small. The architecture test catches the *next*
  occurrence — the value of the plan is preventing recurrence, not
  the 10-line fix.

## Testing Strategy

- **Unit test**: required. Render a food log row with `product_id`
  set, dispatch a click on the produced link, assert
  `navigateToFoodProduct` is called with the expected args.
- **Architecture test**: scan all `web/static/js/**.js` (excluding
  `tests/`) for the regex `on(click|change|submit|input|load|error)=
  ['"]` inside template literals; assert zero matches.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Replace the inline handler

- [ ] read `web/static/js/features/food.js` around line 1620 to
  understand the full DOM context (parent element, what precedes/
  follows)
- [ ] replace the `linkContainer.innerHTML = '<a href="#" onclick=...
  >...'` template at line 1620 with: build the `<a>` via
  `document.createElement('a')`, set `href = '#'`, set `className =
  'food-product-link'`, set `textContent = linkText` (so the link
  text is auto-escaped — was previously interpolated into a
  template-literal but `linkText` is a static string today, so the
  change is defense in depth), then
  `link.addEventListener('click', (event) => { event.preventDefault();
  navigateToFoodProduct(event, log.product_id, log.is_meal); })`,
  then `linkContainer.replaceChildren(link)`
- [ ] preserve the surrounding `linkContainer.classList.remove('hidden')`
  and the empty-state branch (lines 1623-1624 set
  `linkContainer.innerHTML = ''` and add `'hidden'` class — keep both)
- [ ] write a test in
  `web/static/js/tests/food.product-link.test.js` covering:
  rendering with `product_id` set produces a clickable link;
  clicking calls `navigateToFoodProduct(event, productId, isMeal)`;
  rendering without `product_id` hides the container; the link does
  NOT have an `onclick` attribute (regression guard against re-
  introducing the inline form)
- [ ] run `pnpm test food.product-link` — must pass before next task

### Task 2: Architecture test prevents recurrence

- [ ] add `web/static/js/tests/architecture.no-inline-handlers.test.js`
  that reads every file under `web/static/js/` (excluding `tests/` and
  `vendor/`), and for each file, scans for the regex
  `/on(?:click|change|submit|input|load|error|focus|blur|keydown|keyup)=\s*['"][^'"]/i`
  inside the source — fails with the file:line of any match and a
  message pointing at this plan as the recommended pattern
- [ ] verify the architecture test fails when run against the
  pre-fix state (manually re-introduce the inline handler, run test,
  confirm failure, revert)
- [ ] run `pnpm test architecture.no-inline-handlers` — must pass

### Task 3: Verify acceptance

- [ ] grep for `onclick=` (case-insensitive) inside template literals
  in `web/static/js/` returns zero matches:
  `grep -rEn "on(click|change|submit|input|load|error)=" web/static/js
  --include='*.js' | grep -v /tests/`
- [ ] full `pnpm test` clean
- [ ] manually load the app in a real browser (not test harness),
  open a food log entry that has a `product_id`, edit it, click the
  "→ View in Products" link, confirm it navigates to the product
  detail
- [ ] check the browser DevTools Console for any
  `Content-Security-Policy` violations during the above flow —
  should be zero

## Technical Details

### Replacement code (sketch)

```javascript
const linkContainer = document.getElementById('food-product-link-container');
linkContainer.replaceChildren(); // clear
if (log.product_id) {
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'food-product-link';
    link.textContent = log.is_meal ? '→ View Meal' : '→ View in Products';
    link.addEventListener('click', (event) => {
        event.preventDefault();
        navigateToFoodProduct(event, log.product_id, log.is_meal);
    });
    linkContainer.appendChild(link);
    linkContainer.classList.remove('hidden');
} else {
    linkContainer.classList.add('hidden');
}
```

### Architecture-test regex rationale

The regex uses `\s*['"]` to require a quoted attribute value (so plain
`oncall=` in a comment doesn't false-positive). It only flags
attribute syntax inside JS source — HTML files use a different test
(or are checked manually).

### What about `confirm("foo")` and friends?

Native `confirm()`, `alert()`, `prompt()` are not CSP-restricted (they
are window methods, not inline event handlers). Out of scope for this
plan; the existing `safeAlert`/`safeConfirm` wrappers in `core/utils.js`
handle them.

## Post-Completion

**Manual verification** (recommended pre-merge):
- Open the deployed site, check `Content-Security-Policy` response
  header matches `internal/server/server.go:373` (specifically: no
  `'unsafe-inline'` in `script-src`).
- If the deployed CSP differs from the source: file a separate ticket
  to align them. The fix in this plan is correct either way; the CSP
  audit is independent.

**No external system updates needed.** No API or schema change.
