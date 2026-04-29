import json

import medtracker.exceptions as exc

_state: dict = {"value": None, "set": False}


def output(value) -> None:
    """Record the final result of the script. May be called exactly once.

    Raises RuntimeError if called more than once.
    Raises SerializationError if value is not JSON-serializable.
    """
    if _state["set"]:
        raise RuntimeError("output() can only be called once per script")
    try:
        json.dumps(value)
    except (TypeError, ValueError) as e:
        raise exc.SerializationError(
            f"Value is not JSON-serializable: {e}"
        ) from e
    _state["value"] = value
    _state["set"] = True


def _get_output():
    """Return the recorded output value. None when output() was called with None or not called."""
    return _state["value"]


def _is_output_set() -> bool:
    """Return True if output() was called at least once."""
    return _state["set"]


def _reset() -> None:
    """Reset module state between runs. Called by the runner, not scripts."""
    _state["value"] = None
    _state["set"] = False
