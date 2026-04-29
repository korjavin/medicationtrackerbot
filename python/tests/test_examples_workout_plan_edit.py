"""Smoke test for the python/examples/workout_plan_edit.py example.

The example reads a group, picks the first variant, lists its exercises, then
issues one workouts.exercises.update call per exercise. We mock api.call to
verify the iteration, the body shape, and that backend errors are aggregated
into per-exercise statuses without aborting the run.
"""

import importlib.util
import os
import sys
from unittest.mock import patch

import pytest

EXAMPLE_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "examples", "workout_plan_edit.py")
)


def _load_main():
    with open(EXAMPLE_PATH, "r", encoding="utf-8") as f:
        source = f.read()
    source = source.replace("output(main())", "", 1)
    spec = importlib.util.spec_from_loader("workout_plan_edit_test_load", loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, EXAMPLE_PATH, "exec"), module.__dict__)
    return module.main


def _factory(groups, variants, exercises, update_results=None):
    """update_results: dict mapping exercise_id -> "ok" or BaseException to raise."""
    update_results = update_results or {}
    seen = []

    def fake_call(operation_id, params=None, body=None):
        seen.append((operation_id, params, body))
        if operation_id == "workouts.groups.list":
            return groups
        if operation_id == "workouts.variants.list":
            return variants
        if operation_id == "workouts.exercises.list":
            return exercises
        if operation_id == "workouts.exercises.update":
            ex_id = params["id"]
            outcome = update_results.get(ex_id, "ok")
            if isinstance(outcome, BaseException):
                raise outcome
            return None
        raise AssertionError(f"unexpected operation: {operation_id}")

    return fake_call, seen


def test_bumps_each_exercise_by_increment():
    groups = [{"id": 1, "name": "Gym A"}]
    variants = [{"id": 10, "name": "Push Day"}]
    exercises = [
        {"id": 100, "name": "Bench", "sets": 3, "reps": 8, "weight_kg": 60.0, "order_index": 0},
        {"id": 101, "name": "OHP", "sets": 3, "reps": 8, "weight_kg": None, "order_index": 1},
    ]

    fake_call, seen = _factory(groups, variants, exercises)
    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    update_calls = [c for c in seen if c[0] == "workouts.exercises.update"]
    assert len(update_calls) == 2

    # First exercise: existing 60 + 2.5 increment.
    assert update_calls[0][1] == {"id": 100}
    assert update_calls[0][2]["target_weight_kg"] == 62.5
    # Second exercise: None falls back to default 20.
    assert update_calls[1][1] == {"id": 101}
    assert update_calls[1][2]["target_weight_kg"] == 20.0

    assert result["updated"] == 2
    assert result["failed"] == 0
    assert result["group_name"] == "Gym A"
    assert result["variant_name"] == "Push Day"


def test_aggregates_per_exercise_failures():
    from medtracker import exceptions as exc

    groups = [{"id": 1, "name": "Gym A"}]
    variants = [{"id": 10, "name": "Push Day"}]
    exercises = [
        {"id": 100, "name": "Bench", "sets": 3, "reps": 8, "weight_kg": 60.0, "order_index": 0},
        {"id": 101, "name": "OHP", "sets": 3, "reps": 8, "weight_kg": 40.0, "order_index": 1},
    ]
    update_results = {
        101: exc.BackendError("validation failed", status_code=500),
    }

    fake_call, _seen = _factory(groups, variants, exercises, update_results)
    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    assert result["updated"] == 1
    assert result["failed"] == 1
    failed = next(e for e in result["exercises"] if e["status"] == "failed")
    assert failed["id"] == 101
    assert "validation failed" in failed["error"]


def test_handles_no_groups():
    fake_call, seen = _factory([], [], [])
    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    assert [op for op, _, _ in seen] == ["workouts.groups.list"]
    assert result["updated"] == 0
    assert "no workout groups" in result["summary"]


@pytest.fixture(autouse=True)
def _drop_module_cache():
    yield
    sys.modules.pop("workout_plan_edit_test_load", None)
