// The ceremony exit bar (bd med-ckm5.2, design N5 in screens-native.html):
// a 44px strip at the top of every account ceremony page (/unlock, /claim,
// /recover — the shells' AccountURL.isCeremony set), in normal flow, so it
// never covers the page's own Continue. It replaces the native shells' bottom
// bar (iOS CeremonyExitBar, Android ceremonyBar). "Not your account?" confirms,
// then calls the shells' existing account.leave op with no args: the shell
// forgets this account host and shows its native first run. Nothing is erased.
// Shells only — on the web there is no shell to go back to, so no bar.
const CEREMONY_PATHS = ['/unlock', '/claim', '/recover'];

export function mountExitBar(doc = document, win = window) {
  const { pathname, hostname, hash } = win.location;
  if (!CEREMONY_PATHS.includes(pathname)) return null;
  const native = win.LocalNotifications && win.LocalNotifications.__native;
  if (!native || (native.platform !== 'ios' && native.platform !== 'android')) return null;

  const settingUp = pathname === '/claim' || new URLSearchParams(hash.slice(1)).has('claim');
  const verb = settingUp ? 'Setting up' : (pathname === '/recover' ? 'Recovering' : 'Signing in to');

  const bar = doc.createElement('div');
  bar.className = 'wg-exitbar';
  const who = doc.createElement('span');
  who.className = 'wg-exitbar__who';
  const host = doc.createElement('b');
  host.textContent = hostname;
  who.append(`${verb} `, host);
  const leave = doc.createElement('button');
  leave.type = 'button';
  leave.className = 'wg-btn wg-btn--ghost wg-btn--sm wg-exitbar__leave';
  leave.textContent = 'Not your account?';
  bar.append(who, leave);

  // ponytail: safeConfirm until D1 (bd med-ckm5.5) adds the facts/tone dialog
  // with the Copy diagnostics action; the shells keep their own copy action.
  leave.addEventListener('click', () => {
    // One message for every stage: after the passkey step the account already
    // exists, so the design's "nothing is saved until you finish" would be false.
    win.safeConfirm(
      "You'll leave this page and go back to the first screen, where you can paste or scan another invite. Nothing on this device is deleted.",
      (ok) => {
        if (!ok) return;
        native.call('account.leave').catch((e) => {
          // A shell older than the op (it still has its own exit at the bottom).
          const msg = String((e && e.message) || e);
          win.safeAlert(/unsupported/.test(msg) ? 'Update Med Tracker to use this, or use the app’s own “Use another invite” button.' : msg);
        });
      },
      { title: 'Use another invite?', confirmLabel: 'Use another invite', cancelLabel: settingUp ? 'Keep setting up' : 'Stay here', destructive: false },
    );
  });

  doc.body.prepend(bar);
  return bar;
}
