"""Food log — write-mode example for mcp_execute.

Reads the user's daily nutrition targets, lists today's food log to compute
remaining macros, then logs a single new meal through the proxy. Demonstrates:

  - chained reads (`food.targets.read` then `food.log.list`)
  - a single write (`food.log.create`) gated by mode="write"
  - returning a structured summary covering both pre- and post-state

Search-first contract for food logging
--------------------------------------
Always try to reuse an existing product so the user's history stays consistent:

  1. Call `food.products.search` (or `food.products.frequent`) with a query
     close to the planned meal name.
  2. If a matching product is returned, call `food.log.create` with that
     `product_id` and the matched name — the entry rolls up under the saved
     product while still showing a readable meal name in history.
  3. Otherwise call `food.log.create` with `name` only. The server will upsert
     a `food_products` row for that name and return the resolved `product_id`
     in the response so future logs can reuse it.

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


def _find_match(products: list, query: str) -> dict | None:
    """Return the first product whose name reasonably matches the query."""
    if not products:
        return None
    needle = query.lower()
    for p in products:
        name = (p.get("name") or "").lower()
        if not name:
            continue
        if needle in name or any(tok and tok in name for tok in needle.split()):
            return p
    return None


def main() -> dict:
    planned_name = "Chicken rice bowl"
    eaten_at = "2026-04-29T12:30:00Z"

    targets = api.call("food.targets.read") or _macros_zero()

    groups = api.call("food.log.list", params={"days": 1}) or []
    flat: list = []
    for group in groups:
        flat.extend(group.get("logs") or [])
    consumed = _sum_macros(flat)

    remaining = {
        key: max(0, (targets.get(key) or 0) - consumed[key]) for key in consumed
    }

    # Search-first: prefer reusing a saved product before inventing a new name.
    search_result = api.call(
        "food.products.search", params={"q": "chicken rice"}
    ) or []
    if isinstance(search_result, dict):
        candidates = search_result.get("products") or []
    else:
        candidates = search_result
    match = _find_match(candidates, planned_name)

    body = {
        "eaten_at": eaten_at,
        "weight": 220,
        "carbs": 55,
        "protein": 18,
        "fat": 12,
        "calories": 420,
    }
    if match and match.get("id"):
        body["product_id"] = match["id"]
        body["name"] = match.get("name") or planned_name
        reused_product_id = match["id"]
    else:
        body["name"] = planned_name
        reused_product_id = None

    new_log = api.call("food.log.create", body=body)

    resolved_product_id = None
    if isinstance(new_log, dict):
        resolved_product_id = new_log.get("product_id") or reused_product_id

    return {
        "targets": targets,
        "consumed_before": consumed,
        "remaining_before": remaining,
        "logged": {
            "id": new_log.get("id") if isinstance(new_log, dict) else None,
            "name": planned_name,
            "calories": 420,
            "product_id": resolved_product_id,
            "reused_existing_product": match is not None,
        },
        "summary": (
            f"logged 420 kcal lunch (product_id={resolved_product_id}); "
            f"remaining today before lunch: {remaining['calories']} kcal"
        ),
    }


output(main())
