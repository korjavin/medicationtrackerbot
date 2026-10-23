# Agent Instructions

## Product Strategy

Cloud mode (`cmd/cloud`) is the product: the zero-knowledge browser PWA plus
the cloud server. The Telegram bot/server mode was removed in 2026-09
(epic med-a9n5) — `cmd/cloud` is the only runtime, and no doc may present
a bot mode as a deployment target. The removed
Capacitor/mobile shell is frozen on the `mobile` branch and should be treated
as historical.

## Non-Interactive Shell Commands

Shell commands run without a TTY, so a confirmation prompt hangs the agent. Pass the
non-prompting flag where one exists: `ssh`/`scp -o BatchMode=yes`, `apt-get -y`,
`HOMEBREW_NO_AUTO_UPDATE=1` for `brew`.

Issue tracking uses **bd** (beads); run `bd prime` for workflow context.
