"""Food log — write-mode example for mcp_execute.

Reads the user's daily nutrition targets, lists today's food log to compute
remaining macros, then logs a single new meal through the proxy. Demonstrates:

  - chained reads (`food.targets.read` then `food.log.list`)
  - a single write (`food.log.create`) gated by mode="write"
  - returning a structured summary covering both pre- and post-state

Run via mcp_execute with mode="write", a non-empty intent (e.g. "log lunch"),
and topic_allowlist=["food"]. Without mode="write" the proxy rejects the final
call with proxy_denied.
"""

from medtracker import api, output


def _macros_zero() -> dict:
    return {"calories": 0, "carbs": 0, "protein": 0, "fat": 0}


def _sum_macros(logs: list) -> dict:
    totals = _macros_zero()
    for entry in logs:
        totals["calories"] += entry.get("calories", 0) or 0
        totals["carbs"] += entry.get("carbs", 0) or 0
        totals["protein"] += entry.get("protein", 0) or 0
        totals["fat"] += entry.get("fat", 0) or 0
    return totals


def main() -> dict:
    targets = api.call("food.targets.read") or _macros_zero()

    groups = api.call("food.log.list", params={"days": 1}) or []
    flat: list = []
    for group in groups:
        flat.extend(group.get("logs") or [])
    consumed = _sum_macros(flat)

    remaining = {
        key: max(0, (targets.get(key) or 0) - consumed[key]) for key in consumed
    }

    # Log lunch. eaten_at uses RFC3339 in UTC; the backend stores absolute time
    # and the user-facing surface renders it in the user's timezone.
    new_log = api.call(
        "food.log.create",
        body={
            "eaten_at": "2026-04-29T12:30:00Z",
            "weight": 220,
            "carbs": 55,
            "protein": 18,
            "fat": 12,
            "calories": 420,
            "name": "Chicken rice bowl",
        },
    )

    return {
        "targets": targets,
        "consumed_before": consumed,
        "remaining_before": remaining,
        "logged": {
            "id": new_log.get("id") if isinstance(new_log, dict) else None,
            "name": "Chicken rice bowl",
            "calories": 420,
        },
        "summary": (
            f"logged 420 kcal lunch; "
            f"remaining today before lunch: {remaining['calories']} kcal"
        ),
    }


output(main())
