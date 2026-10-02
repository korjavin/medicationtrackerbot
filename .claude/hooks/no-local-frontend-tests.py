#!/usr/bin/env python3
"""PreToolUse(Bash): block local frontend test runs (vitest / pnpm test / npm test).

Owner directive: CI is the only frontend gate. Only command positions are checked,
so commit messages or notes that merely mention "pnpm test" pass.
"""
import json
import re
import sys

cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
for seg in re.split(r"[;&|\n()]+|\$\(|`", cmd):
    words = seg.split()
    while words and re.match(r"^\w+=", words[0]):  # FOO=bar cmd
        words = words[1:]
    if words and words[0] in ("npx", "pnpm", "npm", "yarn") and len(words) > 1:
        if words[1] in ("vitest", "test") or words[1:3] in (["run", "test"], ["exec", "vitest"]):
            break
    elif words and re.search(r"(^|/)vitest$", words[0]):
        break
else:
    sys.exit(0)
sys.stderr.write("BLOCKED: local frontend tests (vitest / pnpm test) are forbidden in this repo; CI is the only frontend gate.\n")
sys.exit(2)
