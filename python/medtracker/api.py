import json
import os
import socket
import urllib.error
import urllib.request

import medtracker.exceptions as exc


def call(operation_id: str, params: dict = None, body=None) -> dict:
    """Call a registered backend operation through the local proxy.

    Returns the parsed response dict on success.
    Raises ProxyDenied for 4xx proxy rejections.
    Raises BackendError for 5xx backend errors.
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
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        status = e.code
        error_body = e.read().decode("utf-8")
        if 400 <= status < 500:
            raise exc.ProxyDenied(
                f"Proxy denied ({status}): {error_body}", status_code=status
            ) from e
        raise exc.BackendError(
            f"Backend error ({status}): {error_body}", status_code=status
        ) from e
    except (TimeoutError, socket.timeout) as e:
        raise exc.TimeoutError("Request to proxy timed out") from e
