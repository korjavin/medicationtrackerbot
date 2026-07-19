// feedback-submit.js — the single integration seam between the capture UI
// (feedback-ui.js, med-dni.2) and the durable submit pipeline (med-dni.3).
//
// A `bundle` is `{ text: string, attachments: [{ type: 'image'|'audio',
// mime: string, bytes: ArrayBuffer|Uint8Array }] }`. It carries ONLY
// user-authored content — no account id, no PII (decided: feedback is
// anonymous). App/version metadata is added at submit time by med-dni.3, not
// here and not by the UI.
//
// This is a STUB. med-dni.3 replaces the body with: age-encrypt to the
// operator recipient (feedback-config.js), enqueue into a durable IndexedDB
// queue, and drain via retry/backoff POST /api/feedback. Until then it just
// resolves so the UI is independently testable.
export async function enqueueFeedback(bundle) {
  // med-dni.3 implements age-encrypt + durable queue + POST /api/feedback.
  const attachmentCount = bundle && Array.isArray(bundle.attachments) ? bundle.attachments.length : 0;
  console.info('[feedback] enqueued (stub)', { hasText: !!(bundle && bundle.text), attachmentCount });
}
