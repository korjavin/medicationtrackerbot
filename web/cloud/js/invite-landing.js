// Invite landing (bd med-ta2n.9): https://<base>/i/<sub>#<token>.
// Placeholder until the landing page bead (med-ta2n.10) ships L1-L3: hand the
// invite straight to the account's own claim page, the old claim form
// https://<sub>.<base>/#claim=<token>. The token stays in the fragment.
const match = /^\/i\/([a-z0-9-]+)$/.exec(location.pathname);
const token = location.hash.slice(1);
if (match && token) {
  location.replace(`https://${match[1]}.${location.host}/#claim=${token}`);
} else {
  document.getElementById('invite-status').textContent = 'This invite link is incomplete. Open the full link you were sent.';
}
