#!/usr/bin/env python3
"""PreToolUse(Bash): block full-suite local frontend test runs (vitest / pnpm test).

Owner directive: CI is the frontend gate for full suite runs. Targeted local
runs with explicit test file paths (e.g. `pnpm test web/static/js/tests/foo.test.js`)
are permitted to avoid unnecessary CI churn on syntax/assertion typos.
"""
import json
import re
import shlex
import sys

# Flags whose next word is a value, not a test target (`-t "name"`, `--reporter dot`).
VALUE_FLAGS = {"-t", "--testNamePattern", "--reporter", "--project", "--config", "-c", "--root", "-r", "--dir", "--shard", "--pool"}

cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
# Quoted-delimiter heredoc bodies are data, not commands (unquoted ones expand `$(…)`, so they
# stay); redirections (`2>&1`, `> out.log`) are not targets.
cmd = re.sub(r"(<<-?\s*(['\"])(\w+)\2[^\n]*)\n.*?\n[ \t]*\3[ \t]*(?=\n|$)", r"\1", cmd, flags=re.S)
cmd = re.sub(r"\d*>>?&?\s*[^\s;&|]+", " ", cmd)
for seg in re.split(r"[;&|\n()]+|\$\(|`", cmd):
    try:
        words = shlex.split(seg)
    except ValueError:
        words = seg.split()
    while words and re.match(r"^\w+=", words[0]):  # FOO=bar cmd
        words = words[1:]
    if not words:
        continue

    is_test = False
    args = []
    if words[0] in ("npx", "pnpm", "npm", "yarn") and len(words) > 1:
        if words[1] in ("vitest", "test") or words[1].startswith("test:"):
            is_test = True
            args = words[2:]
        elif words[1:3] in (["run", "test"], ["exec", "vitest"]) or (words[1] == "run" and len(words) > 2 and words[2].startswith("test:")):
            is_test = True
            args = words[3:]
    elif re.search(r"(^|/)vitest$", words[0]):
        is_test = True
        args = words[1:]

    if is_test:
        # Check if explicit test file targets were provided.
        # Strip flags and their values, '--', and subcommand 'run'.
        targets = []
        skip = False
        for a in args:
            if skip:
                skip = False
            elif a in VALUE_FLAGS:
                skip = True
            elif not a.startswith("-") and a not in ("run", "--"):
                targets.append(a)
        # Allow only if all targets explicitly point to a test file (.test.js, .spec.ts, etc.)
        if targets and all(re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", t) for t in targets):
            continue

        sys.stderr.write(
            "BLOCKED: full-suite local frontend tests are forbidden (CI is the gate). "
            "Run targeted test files instead: pnpm test web/static/js/tests/<file>.test.js\n"
        )
        sys.exit(2)

sys.exit(0)
