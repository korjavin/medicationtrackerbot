"""Workouts overview — read-only example for mcp_execute.

Lists all workout groups, picks the first one, lists its variants, picks the
first variant, lists the exercises in that variant, and emits a compact
summary. The script never touches the database directly: every backend
interaction goes through `medtracker.api.call`, which the executor service
forwards through the proxy → bridge chain.

Run via mcp_execute with mode="read_only" and topic_allowlist=["workouts"].
"""

from medtracker import api, output


def main() -> dict:
    groups = api.call("workouts.groups.list")
    if not groups:
        return {"groups": 0, "summary": "no workout groups configured"}

    first_group = groups[0]
    group_id = first_group["id"]

    variants = api.call("workouts.variants.list", params={"group_id": group_id})
    if not variants:
        return {
            "groups": len(groups),
            "group_id": group_id,
            "group_name": first_group.get("name"),
            "variants": 0,
            "summary": "group has no variants yet",
        }

    first_variant = variants[0]
    variant_id = first_variant["id"]

    exercises = api.call(
        "workouts.exercises.list", params={"variant_id": variant_id}
    )

    return {
        "groups": len(groups),
        "group_id": group_id,
        "group_name": first_group.get("name"),
        "variants": len(variants),
        "variant_id": variant_id,
        "variant_name": first_variant.get("name"),
        "exercises": [
            {
                "name": ex.get("name"),
                "sets": ex.get("sets"),
                "reps": ex.get("reps"),
                "weight_kg": ex.get("weight_kg"),
            }
            for ex in exercises
        ],
        "summary": (
            f"{len(groups)} groups; first group {first_group.get('name')!r} has "
            f"{len(variants)} variants; first variant {first_variant.get('name')!r} "
            f"has {len(exercises)} exercises"
        ),
    }


output(main())
