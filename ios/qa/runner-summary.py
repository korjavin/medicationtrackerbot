#!/usr/bin/env python3
"""Render runner and XCTest timing evidence for a qa-part summary."""
import json
import os
import re
import sys
from pathlib import Path


def read(path):
    try:
        return Path(path).read_text(errors="replace")
    except OSError:
        return ""


def seconds(value):
    if isinstance(value, (int, float)):
        return float(value)
    if re.fullmatch(r"\d+(?:\.\d+)?", str(value)):
        return float(value)
    match = re.fullmatch(r"\s*(?:(\d+(?:\.\d+)?)m\s*)?(?:(\d+(?:\.\d+)?)s)?\s*", str(value))
    if not match or not any(match.groups()):
        return None
    return float(match.group(1) or 0) * 60 + float(match.group(2) or 0)


def cases(node):
    if isinstance(node, dict):
        if node.get("nodeType") == "Test Case":
            yield node
        else:
            for value in node.values():
                yield from cases(value)
    elif isinstance(node, list):
        for value in node:
            yield from cases(value)


boot = read(sys.argv[1])
settle = re.search(r"settled in (\d+)s", boot)
health = re.search(r"healthd ready check (?:took (\d+)s|(skipped))", boot)
print(f"Runner: settle {settle.group(1) + ' s' if settle else 'n/a'}; "
      f"healthd {'skipped' if health and health.group(2) else health.group(1) + ' s' if health else 'n/a'}\n")
try:
    results = json.loads(read(sys.argv[2]))
except ValueError:
    results = {}
baselines = json.loads(os.environ.get("QA_GREEN_SECONDS", "{}"))
print("| test | result | duration | vs green | message |")
print("|---|---|---:|---:|---|")
durations = []
for test in cases(results):
    name = test.get("name") or test.get("nodeIdentifier", "unknown")
    method = name.rsplit("/", 1)[-1].removesuffix("()")
    duration = seconds(test.get("duration"))
    baseline = baselines.get(method)
    factor = duration / baseline if duration is not None and baseline else None
    if duration is not None:
        durations.append((duration, name, factor))
    failures = "; ".join(child.get("name", "") for child in test.get("children", [])
                         if child.get("nodeType") == "Failure Message")
    clean = lambda text: str(text).replace("|", "/").replace("\n", " ")
    print(f"| {clean(name)} | {clean(test.get('result', 'n/a'))} | "
          f"{f'{duration:g} s' if duration is not None else 'n/a'} | "
          f"{f'{factor:.2f}x' if factor is not None else 'n/a'} | {clean(failures)} |")
if durations:
    duration, name, factor = max(durations, key=lambda row: row[0])
    print(f"\nSlowest test: {name} {f'{factor:.2f}x' if factor is not None else 'n/a (no green reference)'}")
else:
    print("\nSlowest test: n/a (no completed durations)")
