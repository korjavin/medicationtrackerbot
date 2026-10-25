#!/usr/bin/env python3
"""PreToolUse(Bash): block full-suite local frontend test runs (vitest / pnpm test).

Owner directive: CI is the frontend gate for full suite runs. Targeted local
runs with explicit test file paths (e.g. `pnpm test web/static/js/tests/foo.test.js`)
are permitted to avoid unnecessary CI churn on syntax/assertion typos.
"""
import json
import re
import sys

cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
for seg in re.split(r"[;&|\n()]+|\$\(|`", cmd):
    words = seg.split()
    while words and re.match(r"^\w+=", words[0]):  # FOO=bar cmd
        words = words[1:]
    if not words:
        continue

    is_test = False
    args = []
    if words[0] in ("npx", "pnpm", "npm", "yarn") and len(words) > 1:
        if words[1] in ("vitest", "test"):
            is_test = True
            args = words[2:]
        elif words[1:3] in (["run", "test"], ["exec", "vitest"]):
            is_test = True
            args = words[3:]
    elif re.search(r"(^|/)vitest$", words[0]):
        is_test = True
        args = words[1:]

    if is_test:
        # Check if any explicit test file path or pattern was provided.
        # Remove flags (e.g. -r, --reporter, -t, etc.), '--', and subcommand words ('run').
        targets = [
            a for a in args
            if not a.startswith("-") and a not in ("run", "--")
        ]
        # Allow if at least one target test file or path is specified.
        if any(re.search(r"\.(test|spec)\.[cm]?[jt]sx?$|\.test$|tests?/|web/", t) for t in targets):
            continue

        sys.stderr.write(
            "BLOCKED: full-suite local frontend tests are forbidden (CI is the gate). "
            "Run targeted test files instead: pnpm test web/static/js/tests/<file>.test.js\n"
        )
        sys.exit(2)

sys.exit(0)
