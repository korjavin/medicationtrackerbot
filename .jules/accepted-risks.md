## Purpose

This file lists security findings the maintainer has reviewed and **deliberately accepted**. Do **not** open PRs that re-litigate these decisions. If you believe new evidence changes the calculus, open an issue first and explain what changed — do not bypass this with another fix PR.

Format mirrors `sentinel.md` but inverts the verdict: instead of "what we learned and prevented," it is "what we considered and chose to leave as-is, with reasoning."

---

## 2026-05-10 — Empty `MCP_ALLOWED_SUBJECT` is an allowed configuration

**Finding:** When `MCP_ALLOWED_SUBJECT` is empty, the MCP server accepts any JWT that passes signature, audience, expiration, and issuer checks — i.e., any valid Pocket-ID token from the configured issuer/client. This corresponds to threat-model entry **TM-008** ("OAuth audience/subject bypass") and the recommendation in `threat-model.md:543` to require `MCP_ALLOWED_SUBJECT` in production.

**Decision:** **Accepted.** The current behavior — treat empty `MCP_ALLOWED_SUBJECT` as "no subject allowlist applied" — is intentional and must remain configurable, including the empty default.

**Why:**
- This is a **single-user, self-hosted** application. The deployer's Pocket-ID instance is typically also single-user or small-group, so the audience + issuer + signature checks already gate access tightly in realistic deployments.
- Forcing a non-empty value would break first-run / fresh-install flows where the operator has not yet captured their own Pocket-ID `sub` UUID. The installer (`cmd/installer/internal/config/env.go:110`) writes the variable but operators frequently leave it blank initially.
- API tokens already bypass `MCP_ALLOWED_SUBJECT` entirely (documented at `docs/mcp-deployment.md:89`). Hardening only the JWT path while leaving the API-token path unchanged would be inconsistent and provide little real defense.
- The deployer who *does* want to restrict by subject can already set the variable; the documentation explains how. Defense-in-depth is opt-in here, not enforced.

**Out of scope for new PRs:**
- Making `MCP_ALLOWED_SUBJECT` mandatory (refusing to start with an empty value).
- Refusing requests when the variable is empty.
- Logging warnings on every request when the variable is empty (noise, not signal — the deployer made the choice once at config time).
- Adding "secure by default" wrappers, env-var validators, or installer prompts that change the empty-is-allowed semantics.

**In scope (still welcome):**
- Improvements to issuer validation, JWKS fetch hardening, audience handling, or replay protection that **do not** depend on `MCP_ALLOWED_SUBJECT` being non-empty.
- Documentation clarifications about when an operator *should* set the variable.
- A one-shot startup log line (info level, not warn) that states the current allowlist mode — acceptable as long as it is not per-request and not styled as a security warning.
