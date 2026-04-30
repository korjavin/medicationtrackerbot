"""Smoke test for the python/examples/food_log.py example.

The example is a write-mode demo: it reads daily targets, sums today's logs,
then logs a single new meal. We mock api.call to verify the operation
sequence, the params/body passed in, and the returned summary shape.
"""

import importlib.util
import os
import sys
from unittest.mock import patch

import pytest

EXAMPLE_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "examples", "food_log.py")
)


def _load_main():
    with open(EXAMPLE_PATH, "r", encoding="utf-8") as f:
        source = f.read()
    source = source.replace("output(main())", "", 1)
    spec = importlib.util.spec_from_loader("food_log_test_load", loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, EXAMPLE_PATH, "exec"), module.__dict__)
    return module.main


def _factory(targets, log_groups, created):
    seen = []

    def fake_call(operation_id, params=None, body=None):
        seen.append((operation_id, params, body))
        if operation_id == "food.targets.read":
            return targets
        if operation_id == "food.log.list":
            return log_groups
        if operation_id == "food.log.create":
            return created
        raise AssertionError(f"unexpected operation: {operation_id}")

    return fake_call, seen


def test_chains_targets_logs_then_create():
    targets = {"calories": 2200, "carbs": 250, "protein": 140, "fat": 70}
    groups = [
        {
            "logs": [
                {"calories": 500, "carbs": 60, "protein": 25, "fat": 15},
                {"calories": 300, "carbs": 40, "protein": 10, "fat": 8},
            ]
        },
        {
            "logs": [
                {"calories": 200, "carbs": 30, "protein": 5, "fat": 2},
            ]
        },
    ]
    created = {"id": 9001, "name": "Chicken rice bowl"}

    fake_call, seen = _factory(targets, groups, created)
    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    op_ids = [op for op, _, _ in seen]
    assert op_ids == ["food.targets.read", "food.log.list", "food.log.create"]

    # food.log.list must be invoked with days=1.
    assert seen[1][1] == {"days": 1}
    # food.log.create body carries the meal.
    body = seen[2][2]
    assert body["name"] == "Chicken rice bowl"
    assert body["calories"] == 420

    assert result["targets"] == targets
    assert result["consumed_before"] == {
        "calories": 1000,
        "carbs": 130,
        "protein": 40,
        "fat": 25,
    }
    assert result["remaining_before"]["calories"] == 1200
    assert result["logged"]["id"] == 9001
    assert "lunch" in result["summary"]


def test_handles_missing_targets_and_empty_log():
    fake_call, seen = _factory(None, [], {"id": 1})
    main = _load_main()
    with patch("medtracker.api.call", fake_call):
        result = main()

    assert result["consumed_before"] == {
        "calories": 0,
        "carbs": 0,
        "protein": 0,
        "fat": 0,
    }
    # remaining_before clamps to zero when targets are missing/zero.
    assert all(v == 0 for v in result["remaining_before"].values())
    # The write call still fires.
    assert seen[-1][0] == "food.log.create"


@pytest.fixture(autouse=True)
def _drop_module_cache():
    yield
    sys.modules.pop("food_log_test_load", None)
