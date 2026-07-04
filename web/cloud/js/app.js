// Entry point for the account-shell page (signup.html). Dispatches to the
// claim/registration wizard or the unlock flow based on observable state
// (credential exists? loss ack set?) rather than a stored step counter — see
// docs/cloud-mode.md Onboarding.

const claimToken = new URLSearchParams(location.hash.slice(1)).get('claim');

if (claimToken) {
  const { runSignupWizard } = await import('./signup.js');
  runSignupWizard(claimToken);
} else {
  const { runUnlockFlow } = await import('./unlock.js');
  runUnlockFlow();
}
