// Entry point for the account-shell page (signup.html). Dispatches to the
// claim/registration wizard or the unlock flow based on observable state
// (credential exists? loss ack set?) rather than a stored step counter — see
// docs/cloud-mode.md Onboarding.

const claimToken = new URLSearchParams(location.hash.slice(1)).get('claim');

// In-app Settings deeplinks (features/deeplink-router.js). Fixed, same-origin
// paths: nothing from the incoming URL is ever forwarded into a redirect.
const SETTINGS_DEVICES_URL = '/?tab=settings&page=devices';
const SETTINGS_CONNECTORS_URL = '/?tab=settings&page=connectors';

// Surface any dispatch failure into #app; an unhandled rejection here would
// otherwise leave the vault entry page blank with no recovery affordance.
function renderFatal(err) {
  const app = document.getElementById('app');
  const section = document.createElement('section');
  section.className = 'wizard-step';
  const h1 = document.createElement('h1');
  h1.textContent = 'Something went wrong';
  const p = document.createElement('p');
  p.className = 'wizard-error';
  p.textContent = `Please reload the page. (${err.message || String(err)})`;
  section.append(h1, p);
  app.replaceChildren(section);
}

try {
  if (location.pathname === '/claim') {
    const { runClaimFlow } = await import('./claim.js');
    await runClaimFlow();
  } else if (location.pathname === '/recover') {
    const { runRecoverFlow } = await import('./recover.js');
    await runRecoverFlow();
  } else if (location.pathname === '/devices' && new URLSearchParams(location.search).get('flow') === 'emergency-kit') {
    // The one devices flow that stays a full-document ceremony (med-xso6.25):
    // Emergency Kit rotation = fresh passkey assertion + the signup kit's
    // download/print gate. Every exit returns to the in-app Devices page.
    const { warmUnlock } = await import('./unlock.js');
    const { renderRegenerateKit } = await import('./devices.js');
    let ctx = null;
    try {
      ctx = await warmUnlock();
    } catch (e) {
      console.error('[devices] warm unlock failed', e);
    }
    if (!ctx) {
      location.href = '/unlock';
    } else {
      renderRegenerateKit(document.getElementById('app'), ctx, () => location.replace(SETTINGS_DEVICES_URL));
    }
  } else if (location.pathname === '/devices' || location.pathname === '/connectors') {
    // Device and connector management live in the app's Settings now
    // (med-xso6.25); the old shell pages are links into it.
    location.replace(location.pathname === '/devices' ? SETTINGS_DEVICES_URL : SETTINGS_CONNECTORS_URL);
  } else if (claimToken) {
    const { runSignupWizard } = await import('./signup.js');
    await runSignupWizard(claimToken);
  } else {
    const { runUnlockFlow } = await import('./unlock.js');
    await runUnlockFlow();
  }
} catch (err) {
  renderFatal(err);
}
