# Plans — historical, non-normative

Everything in this directory and in `completed/` is a **record of intent at a
point in time**. Plans are written before the work, and they are not corrected
afterwards when the implementation diverges — which it routinely does.

**Do not cite a plan as a description of current behavior.** For that, use the
normative set indexed in [../README.md](../README.md):
[architecture.md](../architecture.md),
[security/threat-model.md](../security/threat-model.md),
[cloud-mode.md](../cloud-mode.md),
[cloud-crypto.md](../cloud-crypto.md),
[cloud-operations-security.md](../cloud-operations-security.md), and
[security/release-integrity.md](../security/release-integrity.md).

What plans are genuinely good for: **why** a decision went the way it did, what
alternatives were rejected, and what the author knew at the time. That
reasoning is often not recoverable from the code, which is why these files are
kept rather than deleted.

- `./` — plans for work that is in progress, partially landed, or was never
  finished.
- `completed/` — an archive of finished work. **Do not edit these**, including
  to fix something that later changed; a rewritten archive stops being a
  record.

Some plans describe subjects that are no longer on the deployed path at all
(the removed mobile/Capacitor shell, the Telegram-bot server). They are kept on
the same terms as the rest: read for reasoning, never for current state.
