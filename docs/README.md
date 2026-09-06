# Documentation map

Every file here falls into exactly one of four classes. **Read the class before
you read the document** — a proposal and a normative spec look identical from
the inside, and treating one as the other is how architecture decisions get
made from fiction.

| Class | Means |
|---|---|
| **Normative** | Describes the system as it is. A contradiction with the code is a bug in the doc. |
| **Proposal** | Designed, argued, **not built**. Nothing depends on it. |
| **Reference** | Formats, endpoints, env vars, conventions. Factual, narrower than normative. |
| **Historical** | A record of past work or a point-in-time review. Never cite as current. |

---

## Normative — the current architecture set

Start here. **An architect should be able to determine current data flows,
trust boundaries, and residual risks from these six alone**, without opening a
completed plan or an issue tracker.

| Doc | Answers |
|---|---|
| [architecture.md](architecture.md) | What the components are, where data flows, how sync/reminders/identity/MCP work. **Start here.** |
| [security/threat-model.md](security/threat-model.md) | Assets, trust boundaries, attacker model, what holds, what leaks by design, and the ranked residual risks. |
| [cloud-mode.md](cloud-mode.md) | Per-subsystem detail, and the **generated privacy boundary table** — the canonical, code-derived enumeration of everything that leaves the vault. |
| [cloud-crypto.md](cloud-crypto.md) | Key hierarchy, exact formats, and the enrollment / unlock / recovery / revocation ceremonies. |
| [cloud-operations-security.md](cloud-operations-security.md) | Logs, retention, backups, what deletion actually removes and when, subprocessors, incident response. |
| [security/release-integrity.md](security/release-integrity.md) | The client-code boundary: the operator serves the code that holds your key. What narrows it, what does not, and how to verify a deployment. |

Also normative, narrower in scope:

| Doc | Answers |
|---|---|
| [cloud-deployment.md](cloud-deployment.md) | Standing the service up: DNS, TLS, the app stack, invites, admin CLI, backups, restore, 3am debugging. |
| [frontend.md](frontend.md) | The browser app's own structure: load order, design tokens, data flow, testing posture. |

## Reference

| Doc | Answers |
|---|---|
| [vault-format.md](vault-format.md) | The canonical export/import JSON — field shapes, skip list, round-trip normalizations, age encryption. |
| [environment.md](environment.md) | Environment variables. |
| [features.md](features.md) | User-visible feature behavior. |
| [technical-decisions.md](technical-decisions.md) | Standing frontend decisions: offline writes, 5xx-as-offline, the write-ahead queue, vanilla JS. |
| [mcp-evals.md](mcp-evals.md) | Can a real LLM drive the discover-then-run surface to finish a task. |
| [security/cors-policy.md](security/cors-policy.md) | CORS policy. |

There is deliberately **no current `api.md`**. Cloud mode has no server-side
`/api`: those paths are answered in-process by `web/cloud/js/apishim.js` against
the local vault, and the authoritative list of operations is
`internal/mcp/registry` → `web/cloud/js/mcp-catalog.generated.js`, which is
generated and drift-tested. The old Go-server route table is in
[archive/api.md](archive/api.md).

## Proposals — designed, not built

Each of these is a real design with real reasoning behind it. **None of them is
implemented.** Do not describe their contents as behavior.

| Doc | Status |
|---|---|
| [cloud-key-rotation.md](cloud-key-rotation.md) | Compromised-device eviction via DEK/NK rotation. **Proposal.** Closes the gap named in [threat-model.md §7.3](security/threat-model.md#73-device-removal-is-not-compromise-recovery). |
| [onboarding-wizard.md](onboarding-wizard.md) | A vault-backed first-run overlay. **Partially implemented** — see the status header for what has landed. |
| [gamification.md](gamification.md) | HealthPoints / outcome-in-range scoring. **MVP shipped**; Phase-2 sections remain a proposal (see the status header). |
| [workout-depth.md](workout-depth.md) | Per-set logging → est-1RM/PR → opt-in progression. **Implemented** (epic `med-qj4`, phases 1–4 closed); the doc is the design rationale. |

## Historical

Kept for rationale and provenance. **Never cite as current behavior.**

- **[plans/](plans/)** — implementation plans. `plans/completed/` is an archive
  of finished work; see [plans/README.md](plans/README.md). Neither directory is
  normative, and neither is edited after the fact.
- **[archive/](archive/)** — the Telegram-bot / Go-server material that used to
  live in the current docs:
  [architecture-bot-mode.md](archive/architecture-bot-mode.md),
  [threat-model-bot-mode.md](archive/threat-model-bot-mode.md), and
  [cloud-bot-parity.md](archive/cloud-bot-parity.md), and its runbooks and
  specs: [api.md](archive/api.md), [mcp-deployment.md](archive/mcp-deployment.md),
  [mcp-coverage.md](archive/mcp-coverage.md),
  [mcp-python-executor.md](archive/mcp-python-executor.md),
  [sse-traefik.md](archive/sse-traefik.md),
  [sse-change-stream.md](archive/sse-change-stream.md),
  [demo-mode.md](archive/demo-mode.md), [installer.md](archive/installer.md).
  **That subject is not built, not shipped, not deployed and not operated** —
  the image builds and runs only `./cloud` (`Dockerfile:21,33,47`). Its source
  stays in the tree and still compiles under `go build ./...` so it cannot
  silently rot; that is the whole of its remaining status.

  Two of those still matter to a working developer, so they are called out
  rather than buried: **[archive/mcp-coverage.md](archive/mcp-coverage.md)**
  documents `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`, which **still
  runs** against `internal/server` and will still fail CI — `CLAUDE.md` →
  *Adding a new HTTP route* points at it for that reason. And
  **[archive/installer.md](archive/installer.md)** documents `install.sh`, a
  script that has been **deleted from the repository**; it cannot be followed.
- **[2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md](2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md)**
  — the external privacy audit that drove most of the normative set above. A
  point-in-time review: several of its findings are now closed. Read it for the
  reasoning, not for the current state.
- **[fablesecreview.md](fablesecreview.md)**,
  [2026-05-13-go-code-review.md](2026-05-13-go-code-review.md),
  [2026-05-13-frontend-code-review.md](2026-05-13-frontend-code-review.md),
  [wandergeek-retrospective.md](wandergeek-retrospective.md),
  [2026-07-13-cloud-prf-compatibility-research.md](2026-07-13-cloud-prf-compatibility-research.md)
  — point-in-time reviews and research notes. Left in place rather than moved:
  they record a moment accurately and were never meant to be current, so
  relocating them is churn.

---

## Rules for changing these docs

1. **The privacy boundary table in `cloud-mode.md` is generated.** Its source
   is `web/cloud/js/privacy-manifest.js`. Edit the manifest, run
   `pnpm privacy:docs`, commit the regenerated table. Hand-editing between the
   `<!-- BEGIN GENERATED … -->` markers fails CI.
2. **Never flatten the three activation classes** (off-until-turned-on /
   no-toggle-active-on-use / always-on). The operator-default food DB and RxNav
   have no toggle, and RxNav has no bring-your-own alternative at all. A guard
   bans the flattened phrasing.
3. **Ground normative claims in code**, with a `file:line` where the line
   carries weight. If you cannot verify something, say so in the document
   rather than guessing — a confidently wrong architecture doc is worse than an
   incomplete one.
4. **Do not add a "how it used to work" comparison** to a normative doc. If the
   history is worth keeping, it belongs in `archive/` or a plan.
5. **Promoting a proposal?** Move its row from *Proposals* to *Normative* in
   the same commit that ships the code, and update its own status banner.
