import json
import os
import socket
import urllib.error
import urllib.request

import medtracker.exceptions as exc


def call(operation_id: str, params: dict = None, body=None) -> dict:
    """Call a registered backend operation through the local proxy.

    Returns the parsed response dict on success.
    Raises ProxyDenied for proxy-level rejections (write_blocked, unknown_op, …).
    Raises BackendTransportError when the executor cannot reach the bridge or
    the bridge itself fails (config/HMAC error).
    Raises BackendError for upstream application errors forwarded through the
    bridge (4xx validation, 5xx app errors).
    Raises TimeoutError when the call exceeds the connection timeout.
    """
    proxy_url = os.environ.get("MEDTRACKER_PROXY_URL")
    if not proxy_url:
        raise RuntimeError("MEDTRACKER_PROXY_URL environment variable not set")

    run_token = os.environ.get("MEDTRACKER_RUN_TOKEN", "")

    payload: dict = {"operation_id": operation_id}
    if params is not None:
        payload["params"] = params
    if body is not None:
        payload["body"] = body

    data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        proxy_url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-Run-Token": run_token,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read().decode("utf-8")
            if not payload:
                # 2xx with empty body (e.g. upstream HTTP 204 No Content) is a
                # legitimate "no value" result — surface it as None instead of
                # tripping json.loads("") and raising a script-side ValueError.
                return None
            return json.loads(payload)
    except urllib.error.HTTPError as e:
        status = e.code
        error_body = e.read().decode("utf-8")
        outcome = ""
        if e.headers is not None:
            outcome = e.headers.get("X-MCP-Outcome", "") or ""
        # The executor sets X-MCP-Outcome to classify failure shape:
        #   - proxy_denied: local proxy rejected the call (unknown op, write
        #     blocked, topic not allowed, max calls, bridge feature gate) →
        #     ProxyDenied.
        #   - backend_transport_error: executor couldn't reach the bridge or
        #     the bridge itself failed (HMAC, config, unknown op) → distinct
        #     BackendTransportError so callers can tell a bot/bridge outage
        #     apart from an upstream app-level 5xx.
        #   - backend_response_truncated: bridge truncated the upstream body
        #     at its per-call size cap → BackendResponseTruncated so the
        #     script can retry with a smaller window instead of acting on
        #     silently partial data.
        # Anything else (no marker) is an application-level response forwarded
        # through the bridge → BackendError.
        if outcome == "proxy_denied":
            raise exc.ProxyDenied(
                f"Proxy denied ({status}): {error_body}", status_code=status
            ) from e
        if outcome == "backend_transport_error":
            raise exc.BackendTransportError(
                f"Backend transport error ({status}): {error_body}",
                status_code=status,
            ) from e
        if outcome == "backend_response_truncated":
            raise exc.BackendResponseTruncated(
                f"Backend response truncated ({status}): {error_body}",
                status_code=status,
            ) from e
        raise exc.BackendError(
            f"Backend error ({status}): {error_body}", status_code=status
        ) from e
    except (TimeoutError, socket.timeout) as e:
        raise exc.TimeoutError("Request to proxy timed out") from e
