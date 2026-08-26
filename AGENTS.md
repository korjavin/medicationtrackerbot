# Agent Instructions

## Product Strategy

Cloud mode (`cmd/cloud`) is the default production path. New product work should
target the zero-knowledge browser PWA and cloud server unless the owner
explicitly reactivates another mode. The original Telegram bot/server mode
(`cmd/bot`) is legacy maintenance for existing installs. The removed
Capacitor/mobile shell is frozen on the `mobile` branch and should be treated
as historical.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

Issue tracking uses **bd** (beads); run `bd prime` for workflow context.
