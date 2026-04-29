"""Workout plan edit — write-mode example for mcp_execute.

Finds the first variant in the user's first workout group and bumps the target
weight on every exercise in that variant by 2.5 kg (or sets a default when no
target weight was previously configured). Demonstrates:

  - read → identify (`workouts.groups.list`, `workouts.variants.list`,
    `workouts.exercises.list`)
  - write fan-out (`workouts.exercises.update`) one operation per exercise
  - aggregating per-call results into a single `output(...)` envelope

Run via mcp_execute with mode="write", a non-empty intent (e.g. "progressive
overload bump"), and topic_allowlist=["workouts"]. Each updated exercise
re-validates server-side; failures are captured per-exercise rather than
aborting the whole script.
"""

from medtracker import api, exceptions as exc, output


DEFAULT_WEIGHT_KG = 20.0
INCREMENT_KG = 2.5


def _next_weight(current: float | None) -> float:
    if current is None or current <= 0:
        return DEFAULT_WEIGHT_KG
    return round(current + INCREMENT_KG, 2)


def main() -> dict:
    groups = api.call("workouts.groups.list") or []
    if not groups:
        return {"updated": 0, "summary": "no workout groups configured"}

    group = groups[0]
    variants = api.call("workouts.variants.list", params={"group_id": group["id"]}) or []
    if not variants:
        return {
            "updated": 0,
            "group_name": group.get("name"),
            "summary": f"group {group.get('name')!r} has no variants",
        }

    variant = variants[0]
    exercises = (
        api.call("workouts.exercises.list", params={"variant_id": variant["id"]}) or []
    )

    updates: list[dict] = []
    for ex in exercises:
        current = ex.get("weight_kg")
        target = _next_weight(current)
        try:
            api.call(
                "workouts.exercises.update",
                params={"id": ex["id"]},
                body={
                    "exercise_name": ex.get("name", ""),
                    "target_sets": ex.get("sets") or 3,
                    "target_reps_min": ex.get("reps") or 8,
                    "target_reps_max": ex.get("reps_max"),
                    "target_weight_kg": target,
                    "order_index": ex.get("order_index") or 0,
                },
            )
            updates.append(
                {
                    "id": ex["id"],
                    "name": ex.get("name"),
                    "from_kg": current,
                    "to_kg": target,
                    "status": "updated",
                }
            )
        except (exc.ProxyDenied, exc.BackendError) as err:
            updates.append(
                {
                    "id": ex.get("id"),
                    "name": ex.get("name"),
                    "from_kg": current,
                    "to_kg": target,
                    "status": "failed",
                    "error": str(err),
                }
            )

    successes = sum(1 for u in updates if u["status"] == "updated")
    failures = len(updates) - successes
    return {
        "group_name": group.get("name"),
        "variant_name": variant.get("name"),
        "updated": successes,
        "failed": failures,
        "exercises": updates,
        "summary": (
            f"variant {variant.get('name')!r}: bumped {successes} exercises by "
            f"{INCREMENT_KG} kg ({failures} failed)"
        ),
    }


output(main())
