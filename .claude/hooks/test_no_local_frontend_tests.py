#!/usr/bin/env python3
"""Self-check for no-local-frontend-tests.py: python3 .claude/hooks/test_no_local_frontend_tests.py"""
import json
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).with_name("no-local-frontend-tests.py")
F = "web/static/js/tests/a.test.js"
CASES = {
    f"pnpm test {F}": True,
    f"pnpm test {F} 2>&1 | tail -60": True,
    f'pnpm test {F} -t "snooze row"': True,
    f"pnpm exec vitest run {F} --reporter dot": True,
    f"pnpm test {F} > /tmp/out.log": True,
    "cat > /tmp/x.md <<'EOF'\nrun `pnpm test` / vitest only on touched files\nEOF": True,
    "pnpm test": False,
    "npx vitest run": False,
    "pnpm test web/static/js/tests": False,
    f'pnpm test -t "{F}"': False,
    "cat <<'EOF'\ntext\nEOF\npnpm test": False,
    "cat <<EOF\n$(pnpm test)\nEOF": False,
    "bash <<'EOF'\npnpm test\nEOF": False,
    'echo >"$(pnpm test)"': False,
}
bad = 0
for cmd, allowed in CASES.items():
    r = subprocess.run([sys.executable, HOOK], input=json.dumps({"tool_input": {"command": cmd}}), capture_output=True, text=True)
    if (r.returncode == 0) != allowed:
        bad += 1
        print(f"FAIL ({'want allow' if allowed else 'want block'}): {cmd!r}")
print("ok" if not bad else f"{bad} failed")
sys.exit(1 if bad else 0)
