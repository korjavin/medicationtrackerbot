// Reads the developer's age X25519 recipient pubkey that cmd/cloud injects into
// the app document as a <meta name="medtracker-feedback-age-recipient"> tag (a
// CSP-safe carrier — the origin's script-src 'self' blocks inline scripts; see
// internal/cloudserver/router.go's SetFeedbackRecipient + FEEDBACK_AGE_RECIPIENT
// in docs/environment.md). Empty string = feedback disabled (no meta emitted);
// med-dni.3 hides the capture UI and skips the POST when this returns "".
// Mirrors fooddb.js's operatorFoodDbURL().
export function getFeedbackRecipient() {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="medtracker-feedback-age-recipient"]')?.content || '';
}
