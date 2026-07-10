// Entry point for the account-shell page (signup.html). Dispatches to the
// claim/registration wizard or the unlock flow based on observable state
// (credential exists? loss ack set?) rather than a stored step counter — see
// docs/cloud-mode.md Onboarding.

const claimToken = new URLSearchParams(location.hash.slice(1)).get('claim');

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
  } else if (location.pathname === '/devices') {
    const { warmUnlock } = await import('./unlock.js');
    const { renderDeviceList } = await import('./devices.js');
    try {
      const ctx = await warmUnlock();
      if (!ctx) {
        location.href = '/unlock';
      } else {
        renderDeviceList(document.getElementById('app'), ctx, () => {
          location.href = '/';
        });
      }
    } catch (e) {
      console.error('[devices] warm unlock failed', e);
      location.href = '/unlock';
    }
  } else if (location.pathname === '/connectors') {
    const { warmUnlock } = await import('./unlock.js');
    const { renderConnectors } = await import('./connectors.js');
    try {
      const ctx = await warmUnlock();
      if (!ctx) {
        location.href = '/unlock';
      } else {
        renderConnectors(document.getElementById('app'), ctx, () => {
          location.href = '/';
        });
      }
    } catch (e) {
      console.error('[connectors] warm unlock failed', e);
      location.href = '/unlock';
    }
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
