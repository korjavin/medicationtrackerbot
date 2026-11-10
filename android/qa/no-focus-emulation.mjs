// Playwright 1.56 forces focus on its own CDP session when attaching a page.
// A second CDP session cannot undo it. Disable that one driver command for the
// update-banner lifecycle test only, before Playwright is loaded. Chrome says
// focus emulation suppresses visibilitychange:
// https://developer.chrome.com/docs/devtools/rendering/apply-effects
// Source: https://github.com/microsoft/playwright/blob/v1.56.0/packages/playwright-core/src/server/chromium/crPage.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const file = join(dirname(require.resolve('playwright-core/package.json')), 'lib/server/chromium/crPage.js');
const text = readFileSync(file, 'utf8');
const from = '"Emulation.setFocusEmulationEnabled", { enabled: true }';
const parts = text.split(from);
if (parts.length !== 2) throw new Error('unexpected Playwright focus-emulation implementation');
writeFileSync(file, parts.join('"Emulation.setFocusEmulationEnabled", { enabled: false }'));
console.log('Android update-banner QA: Playwright focus emulation disabled');
