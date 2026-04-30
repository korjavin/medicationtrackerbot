"""Smoke test for the python/examples/workouts_overview.py example.

The example is shipped as a runnable script for the MCP read-only workouts
vertical slice. We import it under a mocked api.call to verify the workflow
chains the three operations correctly and produces the expected summary.
"""

import importlib.util
import os
import sys
from unittest.mock import patch

import pytest

EXAMPLE_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "examples", "workouts_overview.py")
)


def _fake_call_factory(groups, variants, exercises):
    seen = []

    def fake_call(operation_id, params=None, body=None):
        seen.append((operation_id, params))
        if operation_id == "workouts.groups.list":
            return groups
        if operation_id == "workouts.variants.list":
            return variants
        if operation_id == "workouts.exercises.list":
            return exercises
        raise AssertionError(f"unexpected operation: {operation_id}")

    return fake_call, seen


def _load_main():
    """Import the example module fresh and return its main() callable.

    We strip the trailing ``output(main())`` line so the test can call
    ``main()`` independently of the singleton output state.
    """

    with open(EXAMPLE_PATH, "r", encoding="utf-8") as f:
        source = f.read()
    source = source.replace("output(main())", "", 1)

    spec = importlib.util.spec_from_loader("workouts_overview_test_load", loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, EXAMPLE_PATH, "exec"), module.__dict__)
    return module.main


def test_chains_groups_variants_exercises():
    groups = [{"id": 1, "name": "Gym A"}, {"id": 2, "name": "Home"}]
    variants = [{"id": 10, "name": "Push Day"}, {"id": 11, "name": "Pull Day"}]
    exercises = [
        {"id": 100, "name": "Bench Press", "sets": 3, "reps": 8, "weight_kg": 60},
        {"id": 101, "name": "Overhead Press", "sets": 3, "reps": 10, "weight_kg": 40},
    ]
    fake_call, seen = _fake_call_factory(groups, variants, exercises)

    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    op_ids = [op for op, _ in seen]
    assert op_ids == [
        "workouts.groups.list",
        "workouts.variants.list",
        "workouts.exercises.list",
    ]
    assert seen[1][1] == {"group_id": 1}
    assert seen[2][1] == {"variant_id": 10}

    assert result["groups"] == 2
    assert result["group_id"] == 1
    assert result["group_name"] == "Gym A"
    assert result["variants"] == 2
    assert result["variant_id"] == 10
    assert result["variant_name"] == "Push Day"
    assert len(result["exercises"]) == 2
    assert result["exercises"][0]["name"] == "Bench Press"
    assert "Gym A" in result["summary"]
    assert "Push Day" in result["summary"]


def test_handles_no_groups():
    fake_call, seen = _fake_call_factory([], [], [])

    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    # Only the groups call should fire; the script short-circuits on empty groups.
    assert [op for op, _ in seen] == ["workouts.groups.list"]
    assert result["groups"] == 0
    assert "no workout groups" in result["summary"]


def test_handles_no_variants():
    groups = [{"id": 5, "name": "Solo"}]
    fake_call, seen = _fake_call_factory(groups, [], [])

    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    assert [op for op, _ in seen] == [
        "workouts.groups.list",
        "workouts.variants.list",
    ]
    assert result["variants"] == 0
    assert "no variants" in result["summary"]


@pytest.fixture(autouse=True)
def _drop_module_cache():
    # The example is loaded into a one-off module per test, but ensure the
    # medtracker.output singleton state can't leak between tests if a future
    # change re-enables the module-level output(main()).
    yield
    sys.modules.pop("workouts_overview_test_load", None)
