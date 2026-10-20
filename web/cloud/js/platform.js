// Platform probes shared by the account shell (push.js re-exports them for
// signup.js) and the base-domain invite landing (invite-landing.js). A leaf
// module on purpose: push.js pulls sync.js -> /domain/, which the base domain
// does not serve, so the landing page cannot import push.js.

export function isIOS() {
  if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
  // iPadOS 13+ Safari requests desktop sites by DEFAULT, reporting a
  // "Macintosh; Intel Mac OS X" user agent — so the UA test alone misses every
  // stock iPad, on a platform where a browser tab genuinely cannot receive push.
  // Mac-like platform + touch points is the standard discriminator: no Mac
  // reports touch points, and no iPad reports zero.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

// Install guidance is a MOBILE problem (bd med-eas.63): a desktop browser
// delivers web push to a plain tab just fine, so nudging a desktop user to
// install is nagging, not help. A coarse UA test is enough — the only two
// platforms whose install story differs are the two named here, and the copy
// downstream is written per-platform anyway.
export function isMobile() {
  return isIOS() || /Android/i.test(navigator.userAgent);
}
