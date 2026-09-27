# Agent Instructions

## Product Strategy

Cloud mode (`cmd/cloud`) is the default production path. New product work should
target the zero-knowledge browser PWA and cloud server unless the owner
explicitly reactivates another mode. The Telegram bot/server mode (`cmd/bot`) is
legacy: not built, shipped or deployed, but its source must keep compiling and
passing `go test ./...`. The removed
Capacitor/mobile shell is frozen on the `mobile` branch and should be treated
as historical.

## Non-Interactive Shell Commands

Shell commands run without a TTY, so a confirmation prompt hangs the agent. Pass the
non-prompting flag where one exists: `ssh`/`scp -o BatchMode=yes`, `apt-get -y`,
`HOMEBREW_NO_AUTO_UPDATE=1` for `brew`.

Issue tracking uses **bd** (beads); run `bd prime` for workflow context.
