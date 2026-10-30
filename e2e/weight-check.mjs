// Prod check for med-l5yr.5 (weight sanity) against a real deployment.
//
//   invite claim -> PRF passkey -> app unlocked -> seed history
//   -> live session in the real UI: 255 kg jump note -> "It's right"
//   -> reload + reopen (note stays gone) -> band row "Keep 75 kg"
//
// Same harness as vault-roundtrip.mjs (Chromium CDP virtual authenticator with
// PRF). Selectors are the ones the visual runner's workout-weight-check-*
// scenes and web/static/js/features/workout/sessions.js use.
//
//   BASE_URL=https://acct.example.com CLAIM_TOKEN=abc… node weight-check.mjs
//
// Screenshots land in ./out (OUT_DIR overrides).

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE_URL = required('BASE_URL').replace(/\/$/, '');
const CLAIM_TOKEN = required('CLAIM_TOKEN');
const HEADLESS = process.env.HEADED !== '1';
const OUT_DIR = process.env.OUT_DIR || 'out';

const JUMP = 'E2E Goblet Squat';
const BAND = 'E2E Resistance Band Row';

const LOGS = '#workout-session-logs';
const JUMP_NOTE = `${LOGS} .wg-note--warn[data-weight-flag="jump"]`;
const BAND_NOTE = `${LOGS} .wg-note--warn[data-weight-flag="unweighted"]`;

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

let current = 'setup';
const step = (msg) => {
  current = msg;
  console.log(`\n→ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 430, height: 932 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [browser error] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`    [page error] ${e.message}`));

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  try {
    await claimInvite(page);
    await seedHistory(page);
    const sessionId = await jumpNote(page);
    await confirmAndReopen(page, sessionId);
    await bandNote(page);
    console.log('\n✓ PASS — weight-check notes, confirm and reopen all behave');
  } catch (err) {
    await shot(page, 'failure.png').catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

const shot = (page, name) => page.screenshot({ path: `${OUT_DIR}/${name}`, fullPage: false });

// --- signup -----------------------------------------------------------------

async function claimInvite(page) {
  step('1/5 claim the invite with a PRF passkey');
  await page.goto(`${BASE_URL}/#claim=${CLAIM_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/unlock/, { timeout: 30_000 });
  await page.locator('#create-passkey, #unlock-instead').first().waitFor({ timeout: 30_000 });
  if (await page.locator('#unlock-instead').count()) fail('invite was already claimed — mint a fresh one');
  await page.click('#create-passkey');

  // Tail of the wizard (signup.js): an optional Telegram step and, on mobile
  // only, an install step. Kit/loss-ack only with &kit=1, which this omits.
  const deadline = Date.now() + 60_000;
  while (new URL(page.url()).pathname.startsWith('/unlock') && Date.now() < deadline) {
    for (const sel of ['#tg-skip', '#tg-continue', '#install-skip']) {
      const b = page.locator(sel);
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  await waitForVault(page);
  ok('vault open on the account host');
  await dismissFirstRun(page);
}

async function waitForVault(page) {
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady), null, { timeout: 60_000 });
  await page.evaluate(() => window.MedTrackerCloudReady);
  if (!(await page.evaluate(() => Boolean(window.MedTrackerCloud?.ctx)))) fail('boot resolved without an unlocked vault');
}

// W1 picker: pick Workouts only (no Food → no W2 trial step) and continue.
async function dismissFirstRun(page) {
  const overlay = page.locator('#wg-firstrun-overlay');
  try {
    await overlay.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    return; // no first-run overlay on this build
  }
  await page.click('[data-firstrun-feature="workout"]');
  await page.click('[data-firstrun-action="continue"]');
  await overlay.waitFor({ state: 'detached', timeout: 30_000 });
  ok('first-run picker done (Workouts)');
}

// --- seed ---------------------------------------------------------------------

// Through the app's own API (apishim answers it locally), exactly like the
// visual runner's weightCheck step: three completed sessions of the squat at
// 50 kg × 8, and a band exercise with no weighted history.
async function seedHistory(page) {
  step(`1/5 seed: ${JUMP} 3 × 50 kg, ${BAND} with no history`);
  await page.evaluate(
    async ([jump, band]) => {
      const lib = async (name) => {
        const r = await window.apiCall('/api/workout/exercise-library/create', 'POST', {
          name, default_sets: 1, default_reps_min: 8, default_reps_max: null, default_weight_kg: null, notes: '',
        });
        return r.id;
      };
      const jumpId = await lib(jump);
      await lib(band);
      for (let i = 0; i < 3; i++) {
        const s = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
          session_id: s.id, exercise_id: jumpId, exercise_name: jump, source: 'library', status: 'completed',
          sets: [50, 50, 50].map((weight_kg) => ({ weight_kg, reps: 8 })),
        });
        await window.apiCall(`/api/workout/sessions/status?id=${s.id}`, 'PUT', { status: 'completed' });
      }
    },
    [JUMP, BAND],
  );
  ok('seeded');
}

// --- UI helpers ---------------------------------------------------------------

async function addExercise(page, name) {
  const search = page.locator('#workout-session-addstep-search');
  // The modal renders after the ad-hoc POST / reopen lands: an empty session
  // shows the add step, one with exercises shows Next (not both).
  await page.locator('#workout-session-addstep-search, .wg-workouts-session-actions__next').first().waitFor({ timeout: 15_000 });
  if (!(await search.isVisible())) {
    await page.click('.wg-workouts-session-actions__next'); // Next › on the last exercise = add step
  }
  await search.waitFor({ state: 'visible', timeout: 15_000 });
  await search.fill(name);
  const row = page.locator('#workout-session-addstep-list .wg-row', {
    has: page.locator('.wg-row__title', { hasText: new RegExp(`^${name}$`) }),
  });
  await row.first().click({ timeout: 15_000 });
  // The add is optimistic (id 0) and then reopens the modal with the stored
  // log; tapping cells before that reload would land on the discarded render.
  await page.waitForFunction(
    (n) => (window.WorkoutSessionsState.logs || []).some((l) => l.exercise_name === n && Number(l.id) > 0),
    name,
    { timeout: 15_000 },
  );
  await page.locator(`${LOGS} .wg-workouts-session-exercise__name`, { hasText: name }).first().waitFor({ timeout: 15_000 });
  await page.locator(`${LOGS} .wg-set[data-row="0"]`).waitFor({ timeout: 15_000 });
}

// A ghost cell accepts on tap, an inactive row activates; a concrete cell on
// the active row opens the in-page numeric prompt (sessions.js _onSetCellTap).
async function setCell(page, field, value) {
  const cell = page.locator(`${LOGS} .wg-set[data-row="0"] .wg-set__cell[data-field="${field}"]`);
  const input = page.locator('.mt-confirm-modal__input');
  for (let i = 0; i < 3 && !(await input.isVisible().catch(() => false)); i++) {
    await cell.click();
    await input.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  }
  if (!(await input.isVisible())) fail(`no prompt for the ${field} cell`);
  await input.fill(String(value));
  await page.click('.mt-confirm-modal__confirm');
  await input.waitFor({ state: 'detached', timeout: 5_000 });
}

async function logSet(page, kg, reps) {
  await setCell(page, 'weight_kg', kg);
  await setCell(page, 'reps', reps);
  await page.click(`${LOGS} .wg-set[data-row="0"] .wg-set__done`);
  await page.locator(`${LOGS} .wg-set--done[data-row="0"]`).waitFor({ timeout: 10_000 });
}

// --- steps --------------------------------------------------------------------

async function jumpNote(page) {
  step(`2/5 new session: ${JUMP} 255 kg × 8 → jump note`);
  await page.evaluate(() => window.switchTab('workouts'));
  await page.locator('#next-workout-card .wg-workouts-next-card__actions .wg-btn', { hasText: 'Ad hoc' }).click({ timeout: 30_000 });
  await addExercise(page, JUMP);
  await logSet(page, 255, 8);

  const note = page.locator(JUMP_NOTE);
  await note.waitFor({ timeout: 15_000 }).catch(() => fail('no jump note after ticking 255 kg'));
  const text = (await note.innerText()).replace(/\s+/g, ' ');
  if (!/255 kg is .*× your heaviest 50 kg\. A typo\?/.test(text)) fail(`jump note text: "${text}"`);
  for (const label of ['Edit', "It's right"]) {
    if (!(await note.getByRole('button', { name: label, exact: true }).count())) fail(`jump note has no "${label}" button`);
  }
  await shot(page, 'jump-note.png');
  ok(`note: "${text}"`);
  return page.evaluate(() => window.WorkoutSessionsState.data.id);
}

async function confirmAndReopen(page, sessionId) {
  step("3/5 It's right → note gone, survives a reload");
  await page.locator(JUMP_NOTE).getByRole('button', { name: "It's right", exact: true }).click();
  await page.locator(JUMP_NOTE).waitFor({ state: 'detached', timeout: 5_000 }).catch(() => fail("note still shown after It's right"));
  ok('note gone');

  await page.waitForTimeout(3_000); // autosave debounce is 800 ms
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForVault(page);
  await page.evaluate(() => window.switchTab('workouts'));
  // What a History row tap calls (history.js).
  await page.evaluate((id) => window.showWorkoutSessionModal(id), sessionId);
  await page.locator(`${LOGS} .wg-set--done[data-row="0"]`).waitFor({ timeout: 15_000 });
  const kg = await page.locator(`${LOGS} .wg-set--done[data-row="0"] .wg-set__cell[data-field="weight_kg"]`).innerText();
  if (!/^255\b/.test(kg.trim())) fail(`reopened set shows "${kg}", expected 255`);
  await page.waitForTimeout(3_000); // the weight-check read is async; give it time to (wrongly) flag
  if (await page.locator(JUMP_NOTE).count()) fail('jump note is back after reload + reopen');
  await shot(page, 'jump-confirmed-reopen.png');
  ok('reopened: 255 kg kept, no note');
}

async function bandNote(page) {
  step(`4/5 ${BAND} 75 kg × 8 → "Keep 75 kg"`);
  await addExercise(page, BAND);
  await logSet(page, 75, 8);
  const keep = page.locator(BAND_NOTE).getByRole('button', { name: 'Keep 75 kg', exact: true });
  await keep.waitFor({ timeout: 15_000 }).catch(() => fail('no "Keep 75 kg" on the band set'));
  await shot(page, 'band-note.png');
  ok('band note shown');

  step('5/5 Keep → note gone');
  await keep.click();
  await page.locator(BAND_NOTE).waitFor({ state: 'detached', timeout: 5_000 }).catch(() => fail('band note still shown after Keep'));
  ok('band note gone');
}

main().catch((err) => {
  console.error(`\n✗ FAIL at step "${current}" — ${err.message}`);
  process.exit(1);
});
